classdef NodePlacerOptimizer
% NodePlacerOptimizer  -  Unified, fully-automatic node placement + optimization.
%
% USAGE
%   npo    = NodePlacerOptimizer();
%   result = npo.run(campusImg, stage1_out);         % mask auto-generated
%   result = npo.run(campusImg, stage1_out, mask);   % supply your own mask
%
% KEY PROPERTY
%   MaxNodes = 0   ->  unconstrained: find minimum nodes for full coverage
%   MaxNodes = N   ->  budget mode: exact ILP maximises coverage with <= N nodes
%
% BUDGET ILP (exact math model)
%   Variables  : x_j in {0,1}  (node placed at candidate j)
%                y_i in {0,1}  (dead-zone target i is covered)
%   Objective  : max  sum_i  y_i
%   Subject to :
%     C1  sum_j x_j            <= N_max           (budget)
%     C2  y_i - sum_j A_ij*x_j <= 0  for all i   (coverage relation)
%     C3  x_j + x_k            <= 1  for all pairs with d(j,k) < tau
%                                                  (min distance, tau=50 px)
%     C4  sum_{j in sector s} x_j <= ceil(N_max/K) per sector
%                                                  (anti-clustering)
%     x_j, y_i in {0,1}
%   Coverage % = (sum y_i / M) * 100
%
% OUTPUT  result struct
%   .img                  Resized campus image
%   .transmitter          [X, Y] transmitter in image space
%   .bestR                Exclusion radius from candidate sweep
%   .heatImg              RSSI heatmap (dBm) resized to image space
%   .binaryMask           Building mask (1=building, 0=air)
%   .deadZoneMask         Binary dead-zone matrix
%   .candidateLocations   Full L candidate pool  Mx2 [X,Y]
%   .clusterCentroids     Dead-zone centroids    Kx2 [X,Y]
%   .adjacency            Adjacency matrix K x M
%   .nodesBeforeOpt       Placed nodes after ILP, before post-processing
%   .finalNodes           Final placed nodes
%   .coverageFraction     Fraction of dead-zone clusters covered [0,1]

    properties
        DeadZoneThreshold_dBm   = -60;
        MinClusterAreaPx        = 20;
        ImageScaleFactor        = 1.0;
        RadiiToTest             = 20:10:120;
        MaxCandidates           = 300;
        CoverageRatio_target    = 0.80;
        NodeCoverageRadius      = 50;    % tau – also used as min node distance
        NumSectors              = 12;
        MinDistPruning          = 70;
        SectorAngleDelta        = 5;
        StdDeviationThreshold   = 10;
        StrongSignalThreshold   = -18;
        MaxNodes                = 0;     % 0 = unconstrained; N>0 = budget cap
    end

    % =====================================================================
    methods (Access = public)
    % =====================================================================

        function result = run(obj, campusImg, stage1_out, binaryMask)

            % -- 0. Resize campus image & map transmitter to image space --
            img = imresize(campusImg, obj.ImageScaleFactor);
            [h_img, w_img, ~] = size(img);

            [h_heat, w_heat] = size(stage1_out.mag_db);
            tx = round((stage1_out.src_x / w_heat) * w_img);
            ty = round((stage1_out.src_y / h_heat) * h_img);
            tx = max(1, min(w_img, tx));
            ty = max(1, min(h_img, ty));

            % Building / air masks
            if nargin >= 4 && ~isempty(binaryMask)
                buildMask = imresize(binaryMask, [h_img, w_img]) > 0.5;
            else
                grayImg   = rgb2gray(img(:,:,1:3));
                buildMask = grayImg > (graythresh(grayImg) * 255 * 0.8);
            end
            pathsMask = ~buildMask;

            % Resize heatmap once to image space
            heatImg = imresize(stage1_out.mag_db, [h_img, w_img]);

            % -- Step 1: Dead-zone extraction & clustering --
            [clusters, numClusters, deadZoneMask] = obj.extractClusters(heatImg);

            if numClusters == 0
                warning('NodePlacerOptimizer: No dead zones found.');
                result = obj.emptyResult(img, [tx, ty], heatImg, buildMask, ...
                                          false(h_img, w_img));
                return;
            end

            % -- Step 2: Polar transformation --
            clusters = obj.polarTransform(clusters, tx, ty);

            % -- Step 3: Candidate location generation --
            [candidates_xy, bestR, fullCandidates] = obj.generateCandidates( ...
                pathsMask, clusters, tx, ty, h_img, w_img);

            if isempty(candidates_xy)
                warning('NodePlacerOptimizer: No valid candidate locations.');
                result = obj.emptyResult(img, [tx, ty], heatImg, buildMask, deadZoneMask);
                return;
            end

            % -- Step 4: Sector mapping --
            [clusterSectors, activeSectors] = obj.mapSectors(clusters);

            % -- Step 5: Adjacency matrix (clusters x candidates) --
            A_mat = obj.buildAdjacency(clusters, candidates_xy);

            % -- Step 6: Solve --
            %    MaxNodes == 0  ->  minimum set cover ILP
            %    MaxNodes >  0  ->  exact budget ILP (math model)
            if obj.MaxNodes > 0
                [selectedIdx, covFracILP] = obj.solveBudgetILP( ...
                    A_mat, candidates_xy, clusters, tx, ty, obj.MaxNodes);
            else
                covFracILP = [];
                selectedIdx = obj.solveMinCoverILP(A_mat, candidates_xy, clusters, ...
                                                    clusterSectors, activeSectors, tx, ty);
            end
            placedNodes = candidates_xy(selectedIdx, :);

            % -- Step 7: Strict air + boundary filter  ->  nodesBeforeOpt --
            placedNodes    = obj.strictAirFilter(placedNodes, pathsMask, h_img, w_img);
            nodesBeforeOpt = placedNodes;

            % -- Steps 8-9: RF pruning + spatial diversity (unconstrained only) --
            if obj.MaxNodes == 0
                placedNodes = obj.rfSectorPrune(placedNodes, heatImg, tx, ty, w_img, h_img);
                placedNodes = obj.spatialDiversityEnforce(placedNodes);
            end

            % -- Post-placement fitness: remove zero-gain nodes --
            if obj.MaxNodes > 0 && ~isempty(placedNodes)
                placedNodes = obj.removZeroGainNodes(placedNodes, clusters);
            end

            % Coverage fraction
            coverageFraction = obj.computeCoverage(placedNodes, clusters);

            % -- Pack result --
            result.img                = img;
            result.transmitter        = [tx, ty];
            result.bestR              = bestR;
            result.heatImg            = heatImg;
            result.binaryMask         = buildMask;
            result.deadZoneMask       = deadZoneMask;
            result.candidateLocations = fullCandidates;
            result.clusterCentroids   = [[clusters.cx]', [clusters.cy]'];
            result.adjacency          = A_mat;
            result.nodesBeforeOpt     = nodesBeforeOpt;
            result.finalNodes         = placedNodes;
            result.coverageFraction   = coverageFraction;
        end

        % ------------------------------------------------------------------
        % Budget selection from already-optimized nodes
        %
        % The main simulation already produced N optimized nodes (e.g. 29)
        % that together give full coverage.  The user says they can only
        % afford M <= N nodes (e.g. 15).  This method picks the BEST M
        % from those N nodes to maximise dead-zone coverage — using the
        % same exact ILP math model — without re-running the full pipeline.
        %
        % Math model (applied to the final node set as candidates):
        %   Variables  : x_j in {0,1}  (keep node j from the final set)
        %                y_i in {0,1}  (dead-zone cluster i is covered)
        %   Objective  : max  sum_i y_i
        %   Subject to :
        %     C1  sum_j x_j            <= maxNodes      (budget)
        %     C2  y_i - sum_j A_ij*x_j <= 0  for all i (coverage relation)
        %     C3  x_j + x_k            <= 1  for pairs d(j,k) < tau
        %     C4  sector limit per sector
        %     x_j, y_i in {0,1}
        %
        % INPUTS
        %   mainResult  – struct returned by run() with MaxNodes = 0
        %   maxNodes    – budget (max nodes to keep)
        %
        % OUTPUT
        %   budgetResult – struct with .finalNodes, .coverageFraction, etc.
        % ------------------------------------------------------------------
        function budgetResult = runBudget(obj, mainResult, maxNodes)

            finalNodes = mainResult.finalNodes;   % N x 2  [X, Y]
            N = size(finalNodes, 1);

            if N == 0
                budgetResult = mainResult;
                budgetResult.finalNodes       = zeros(0,2);
                budgetResult.coverageFraction = 0;
                return;
            end

            if maxNodes >= N
                fprintf('Budget (%d) >= nodes available (%d): returning full node set.\n', ...
                        maxNodes, N);
                budgetResult = mainResult;
                return;
            end

            % Rebuild cluster struct from clusterCentroids in mainResult
            CC = mainResult.clusterCentroids;   % K x 2
            K  = size(CC, 1);
            clusters = struct('cx', num2cell(CC(:,1)'), 'cy', num2cell(CC(:,2)'), ...
                              'area', num2cell(ones(1,K)), 'meanRSSI', num2cell(zeros(1,K)), ...
                              'r', num2cell(zeros(1,K)), 'theta', num2cell(zeros(1,K)));

            tx = mainResult.transmitter(1);
            ty = mainResult.transmitter(2);

            % A_mat: K clusters x N final-nodes  (same radius as main run)
            A_mat = obj.buildAdjacency(clusters, finalNodes);

            % Backward elimination: drop the node with smallest coverage
            % loss one at a time until maxNodes nodes remain.
            % No ILP, no new placement, no optimization — coordinates fixed.
            selectedNodes = obj.backwardElimination(finalNodes, A_mat, K, maxNodes);
            covFrac       = obj.computeCoverage(selectedNodes, clusters);

            % Pack result (reuse everything from mainResult, replace nodes)
            budgetResult                  = mainResult;
            budgetResult.finalNodes       = selectedNodes;
            budgetResult.nodesBeforeOpt   = selectedNodes;
            budgetResult.coverageFraction = covFrac;
        end

    end  % public methods


    % =====================================================================
    methods (Access = private)
    % =====================================================================

        % ------------------------------------------------------------------
        % Step 1 – Dead-zone extraction & clustering
        % ------------------------------------------------------------------
        function [clusters, numClusters, deadZoneMask] = extractClusters(obj, heatImg)
            deadZoneMask = heatImg < obj.DeadZoneThreshold_dBm;
            CC    = bwconncomp(deadZoneMask, 8);
            stats = regionprops(CC, 'Area', 'Centroid', 'PixelIdxList');

            clusters    = struct('cx',{}, 'cy',{}, 'area',{}, ...
                                 'meanRSSI',{}, 'r',{}, 'theta',{});
            numClusters = 0;

            for k = 1:length(stats)
                if stats(k).Area < obj.MinClusterAreaPx, continue; end
                numClusters = numClusters + 1;
                clusters(numClusters).cx       = stats(k).Centroid(1);
                clusters(numClusters).cy       = stats(k).Centroid(2);
                clusters(numClusters).area     = stats(k).Area;
                clusters(numClusters).meanRSSI = mean(heatImg(stats(k).PixelIdxList));
                clusters(numClusters).r        = 0;
                clusters(numClusters).theta    = 0;
            end
        end

        % ------------------------------------------------------------------
        % Step 2 – Polar transformation of cluster centroids
        % ------------------------------------------------------------------
        function clusters = polarTransform(~, clusters, tx, ty)
            for k = 1:length(clusters)
                dx = clusters(k).cx - tx;
                dy = clusters(k).cy - ty;
                clusters(k).r     = sqrt(dx^2 + dy^2);
                clusters(k).theta = mod(atan2d(dy, dx), 360);
            end
        end

        % ------------------------------------------------------------------
        % Step 3 – Candidate location generation
        %   Returns the subsampled working set (candidates_xy), the chosen
        %   exclusion radius (bestR), and the full air-pixel pool (fullCandidates).
        %   Edge margin = NodeCoverageRadius/2 keeps nodes inside the map.
        % ------------------------------------------------------------------
        function [candidates_xy, bestR, fullCandidates] = generateCandidates( ...
                obj, pathsMask, clusters, tx, ty, h_img, w_img)

            % Interior-only air pixels (strip edge padding & colorbar border)
            margin = max(5, round(obj.NodeCoverageRadius / 2));
            edgeMask = false(h_img, w_img);
            edgeMask(margin+1:h_img-margin, margin+1:w_img-margin) = true;
            interiorMask = pathsMask & edgeMask;

            [rAll, cAll] = find(interiorMask);
            L_pool = [cAll, rAll];  % [X, Y]

            if isempty(L_pool)
                [rAll, cAll] = find(pathsMask);
                L_pool = [cAll, rAll];
            end
            if isempty(L_pool)
                L_pool = [round(w_img/2), round(h_img/2)];
            end

            fullCandidates = L_pool;

            K    = length(clusters);
            D_xy = [[clusters.cx]', [clusters.cy]'];

            bestR    = obj.RadiiToTest(1);
            minNodes = inf;

            for r = obj.RadiiToTest
                distTx    = sqrt((L_pool(:,1)-tx).^2 + (L_pool(:,2)-ty).^2);
                validPool = L_pool(distTx >= r, :);
                if isempty(validPool), continue; end

                step  = max(1, floor(size(validPool,1)/120));
                L_sub = validPool(1:step:end, :);

                A_temp = false(K, size(L_sub,1));
                for j = 1:size(L_sub,1)
                    d = sqrt((D_xy(:,1)-L_sub(j,1)).^2 + (D_xy(:,2)-L_sub(j,2)).^2);
                    A_temp(d <= obj.NodeCoverageRadius, j) = true;
                end

                covRatio = sum(any(A_temp,2)) / K;
                estNodes = sum(any(A_temp,1));

                if covRatio >= obj.CoverageRatio_target && estNodes < minNodes
                    minNodes = estNodes;
                    bestR    = r;
                end
            end

            distTx    = sqrt((L_pool(:,1)-tx).^2 + (L_pool(:,2)-ty).^2);
            finalPool = L_pool(distTx >= bestR, :);
            if isempty(finalPool), finalPool = L_pool; end

            step          = max(1, floor(size(finalPool,1)/obj.MaxCandidates));
            candidates_xy = finalPool(1:step:end, :);
        end

        % ------------------------------------------------------------------
        % Step 4 – Sector mapping
        % ------------------------------------------------------------------
        function [clusterSectors, activeSectors] = mapSectors(obj, clusters)
            deltaTh        = 360 / obj.NumSectors;
            clusterSectors = zeros(length(clusters),1);
            for k = 1:length(clusters)
                clusterSectors(k) = min(floor(clusters(k).theta/deltaTh)+1, obj.NumSectors);
            end
            activeSectors = unique(clusterSectors);
        end

        % ------------------------------------------------------------------
        % Step 5 – Adjacency matrix  A(i,j) = 1 if candidate j covers cluster i
        % ------------------------------------------------------------------
        function A_mat = buildAdjacency(obj, clusters, candidates_xy)
            K     = length(clusters);
            M     = size(candidates_xy,1);
            A_mat = false(K, M);
            for j = 1:M
                dx = [clusters.cx]' - candidates_xy(j,1);
                dy = [clusters.cy]' - candidates_xy(j,2);
                A_mat(sqrt(dx.^2+dy.^2) <= obj.NodeCoverageRadius, j) = true;
            end
        end

        % ------------------------------------------------------------------
        % Step 6a – Budget ILP  (exact math model, called when MaxNodes > 0)
        %
        % Variables : z = [x(1..M);  y(1..K)]
        %   x_j in {0,1}  – node placed at candidate j
        %   y_i in {0,1}  – dead-zone target i is covered
        %
        % Objective : min [zeros(M,1); -ones(K,1)]' * z   (= max sum y_i)
        %
        % Constraints
        %   C1  [ones(1,M) zeros(1,K)] * z  <= N_max          (budget)
        %   C2  [-A | I_K]             * z  <= 0  (K rows)    (coverage relation)
        %   C3  x_j + x_k             <= 1  for each pair     (min dist tau)
        %   C4  sector sums of x       <= ceil(N_max/K_sec)   (anti-cluster)
        % ------------------------------------------------------------------
        function [selectedIdx, covFrac] = solveBudgetILP(obj, A_mat, candidates_xy, ...
                                                          clusters, tx, ty, maxNodes)
            K = size(A_mat, 1);   % dead-zone targets (cluster centroids)
            M = size(A_mat, 2);   % candidate locations

            tau = obj.NodeCoverageRadius;   % minimum distance between any two nodes

            % ---- variable layout: [x(1..M), y(1..K)] ----
            nVars  = M + K;
            f      = [zeros(M,1); -ones(K,1)];   % minimize -> maximise coverage
            intV   = 1:nVars;
            lb     = zeros(nVars, 1);
            ub     = ones(nVars, 1);

            % ---- C1: budget ----
            A_c1 = [ones(1,M), zeros(1,K)];
            b_c1 = maxNodes;

            % ---- C2: coverage relation  y_i <= sum_j A_ij*x_j ----
            %   => [-A | I_K] * [x;y] <= 0
            A_c2 = [-double(A_mat), eye(K)];
            b_c2 = zeros(K, 1);

            % ---- C3: minimum distance tau between any two placed nodes ----
            %   For each pair (j,k) with d(j,k) < tau: x_j + x_k <= 1
            dx_pair = candidates_xy(:,1) - candidates_xy(:,1)';
            dy_pair = candidates_xy(:,2) - candidates_xy(:,2)';
            pairD   = sqrt(dx_pair.^2 + dy_pair.^2);
            [jIdx, kIdx] = find(triu(pairD < tau, 1));   % upper triangle only
            nPairs  = numel(jIdx);
            A_c3 = zeros(nPairs, nVars);
            for p = 1:nPairs
                A_c3(p, jIdx(p)) = 1;
                A_c3(p, kIdx(p)) = 1;
            end
            b_c3 = ones(nPairs, 1);

            % ---- C4: sector anti-clustering ----
            %   At most ceil(maxNodes / NumSectors) nodes per angular sector.
            K_sec       = obj.NumSectors;
            maxPerSec   = ceil(maxNodes / K_sec);
            deltaTh     = 360 / K_sec;
            candAngles  = mod(atan2d(candidates_xy(:,2)-ty, ...
                                     candidates_xy(:,1)-tx), 360);
            A_c4_rows = {};
            b_c4_vals = [];
            for s = 1:K_sec
                aMin  = (s-1) * deltaTh;
                aMax  =  s    * deltaTh;
                inSec = find(candAngles >= aMin & candAngles < aMax);
                if numel(inSec) > maxPerSec
                    row = zeros(1, nVars);
                    row(inSec) = 1;
                    A_c4_rows{end+1} = row; %#ok<AGROW>
                    b_c4_vals(end+1) = maxPerSec; %#ok<AGROW>
                end
            end
            if ~isempty(A_c4_rows)
                A_c4 = cell2mat(A_c4_rows');
                b_c4 = b_c4_vals(:);
            else
                A_c4 = zeros(0, nVars);
                b_c4 = zeros(0, 1);
            end

            % ---- Assemble & solve ----
            A_ineq = [A_c1; A_c2; A_c3; A_c4];
            b_ineq = [b_c1; b_c2; b_c3; b_c4];

            opts = optimoptions('intlinprog', 'Display','off', ...
                                'MaxTime', 120);
            [z_sol, ~, exitflag] = intlinprog(f, intV, A_ineq, b_ineq, ...
                                               [], [], lb, ub, opts);

            if exitflag > 0 && ~isempty(z_sol)
                selectedIdx = find(z_sol(1:M) > 0.5);
                covFrac     = sum(z_sol(M+1:end) > 0.5) / K;
            else
                % Fallback: spread-first greedy (never crashes)
                fprintf('Budget ILP: solver did not converge (flag %d), using greedy fallback.\n', ...
                        exitflag);
                selectedIdx = obj.greedyBudgetSpread(A_mat, candidates_xy, maxNodes, tau);
                covFrac     = obj.computeCoverage( ...
                    candidates_xy(selectedIdx,:), clusters);
            end

            if isempty(selectedIdx)
                selectedIdx = (1:min(maxNodes,M))';
                covFrac = 0;
            end
        end

        % ------------------------------------------------------------------
        % Step 6b – Minimum set cover ILP (called when MaxNodes == 0)
        %   Minimises number of nodes while covering all clusters and
        %   placing at least one node per active sector.
        % ------------------------------------------------------------------
        function selectedIdx = solveMinCoverILP(obj, A_mat, candidates_xy, clusters, ...
                                                 clusterSectors, activeSectors, tx, ty)
            M = size(candidates_xy, 1);
            opts = optimoptions('intlinprog', 'Display','off');

            rowsCovered = find(any(A_mat,2));
            A_c1 = double(A_mat(rowsCovered,:));
            b_c1 = ones(length(rowsCovered),1);

            deltaTh    = 360 / obj.NumSectors;
            nActive    = length(activeSectors);
            candAngles = mod(atan2d(candidates_xy(:,2)-ty, candidates_xy(:,1)-tx), 360);
            candSec    = min(floor(candAngles/deltaTh)+1, obj.NumSectors);

            B_sec = false(nActive, M);
            for si = 1:nActive
                B_sec(si, candSec == activeSectors(si)) = true;
            end
            validSec    = any(B_sec,2);
            B_sec_valid = double(B_sec(validSec,:));
            b_c2        = ones(sum(validSec),1);

            A_ineq = [-A_c1; -B_sec_valid];
            b_ineq = [-b_c1; -b_c2];

            [x_sol, ~, exitflag] = intlinprog(ones(M,1), 1:M, A_ineq, b_ineq, ...
                                               [], [], zeros(M,1), ones(M,1), opts);
            if exitflag > 0 && ~isempty(x_sol)
                selectedIdx = find(x_sol > 0.5);
            else
                selectedIdx = obj.greedySetCover(A_mat);
            end
            if isempty(selectedIdx)
                selectedIdx = (1:min(10,M))';
            end
        end

        % ------------------------------------------------------------------
        % Backward elimination  (used exclusively by runBudget)
        %
        % Starts from all N already-optimized nodes.
        % Each iteration: try removing every remaining node one at a time,
        % measure the coverage loss, then permanently remove the one that
        % caused the SMALLEST loss (i.e. least important node).
        % Repeats until exactly maxNodes nodes remain.
        %
        % Node positions are NEVER changed. No new nodes are added.
        % No placement or optimization is re-run.
        %
        % Inputs:
        %   finalNodes  – N x 2 matrix of fixed optimized node coordinates
        %   A_mat       – K x N logical coverage matrix (cluster x node)
        %   K           – number of dead-zone clusters
        %   maxNodes    – target number of nodes to keep
        %
        % Output:
        %   selectedNodes – maxNodes x 2 (or fewer if N < maxNodes)
        % ------------------------------------------------------------------
        function selectedNodes = backwardElimination(~, finalNodes, A_mat, K, maxNodes)
            N = size(finalNodes, 1);

            if maxNodes >= N
                selectedNodes = finalNodes;
                return;
            end

            active = true(N, 1);   % all nodes start as active

            while sum(active) > maxNodes
                activeIdx  = find(active);
                nActive    = numel(activeIdx);

                % Current coverage with all active nodes
                covNow = sum(any(A_mat(:, active), 2));

                minLoss  = Inf;
                dropNode = activeIdx(1);   % fallback

                for k = 1:nActive
                    j = activeIdx(k);

                    % Temporarily deactivate node j
                    active(j) = false;
                    covWithout = sum(any(A_mat(:, active), 2));
                    active(j) = true;   % restore

                    loss = covNow - covWithout;
                    if loss < minLoss
                        minLoss  = loss;
                        dropNode = j;
                    end
                end

                % Permanently remove the least-important node
                active(dropNode) = false;
            end

            selectedNodes = finalNodes(active, :);
        end

        % ------------------------------------------------------------------
        % Lean subset-selection ILP  (used exclusively by runBudget)
        %
        % Picks the best M nodes from the N already-optimized nodes to
        % maximise dead-zone cluster coverage.
        %
        % Only two constraints:
        %   C1  sum_j x_j <= maxNodes          (budget)
        %   C2  y_i <= sum_j A_ij*x_j          (coverage relation)
        %
        % NO minimum-distance constraint  — nodes are fixed, already placed.
        % NO sector constraint            — already enforced at placement time.
        %
        % Variables : z = [x(1..N); y(1..K)]
        %   x_j in {0,1}  keep node j
        %   y_i in {0,1}  cluster i is covered
        % Objective : min [zeros(N,1); -ones(K,1)]'*z  (= max coverage)
        % ------------------------------------------------------------------
        function [selectedIdx, covFrac] = selectBestSubsetILP(~, A_mat, N, K, maxNodes)
            % Variable layout: [x(1..N), y(1..K)]
            nVars = N + K;
            f     = [zeros(N,1); -ones(K,1)];   % maximise coverage
            lb    = zeros(nVars, 1);
            ub    = ones(nVars, 1);
            intV  = 1:nVars;

            % C1 – budget
            A_c1 = [ones(1,N), zeros(1,K)];
            b_c1 = maxNodes;

            % C2 – coverage relation:  y_i - sum_j(A_ij * x_j) <= 0
            A_c2 = [-double(A_mat), eye(K)];
            b_c2 = zeros(K, 1);

            A_ineq = [A_c1; A_c2];
            b_ineq = [b_c1; b_c2];

            opts = optimoptions('intlinprog', 'Display','off', 'MaxTime', 60);
            [z_sol, ~, exitflag] = intlinprog(f, intV, A_ineq, b_ineq, ...
                                               [], [], lb, ub, opts);

            if exitflag > 0 && ~isempty(z_sol)
                selectedIdx = find(z_sol(1:N) > 0.5);
                covFrac     = sum(z_sol(N+1:end) > 0.5) / K;
            else
                % Greedy fallback: iteratively pick the node that covers
                % the most still-uncovered clusters
                fprintf('Subset ILP: solver flag %d, using greedy fallback.\n', exitflag);
                uncovered   = true(K, 1);
                selectedIdx = zeros(maxNodes, 1);
                nPicked     = 0;
                for n = 1:maxNodes
                    gains = sum(A_mat(uncovered, :), 1);
                    if all(gains == 0), break; end
                    [~, best]    = max(gains);
                    nPicked      = nPicked + 1;
                    selectedIdx(nPicked) = best;
                    uncovered(A_mat(:, best)) = false;
                    if ~any(uncovered), break; end
                end
                selectedIdx = selectedIdx(1:nPicked);
                covFrac     = sum(~uncovered) / K;
            end

            if isempty(selectedIdx)
                selectedIdx = (1:min(maxNodes, N))';
                covFrac     = 0;
            end
        end

        % ------------------------------------------------------------------
        % Fallback: greedy budget solver with spread enforcement
        %   Used when intlinprog fails in budget mode.
        %   Each step picks the candidate that (a) is >= tau away from all
        %   already-placed nodes, and (b) covers the most uncovered targets.
        % ------------------------------------------------------------------
        function selectedIdx = greedyBudgetSpread(obj, A_mat, candidates_xy, ...
                                                   maxNodes, tau)
            M = size(candidates_xy, 1);
            K = size(A_mat, 1);
            uncovered   = true(K, 1);
            selectedIdx = zeros(maxNodes, 1);
            nPlaced     = 0;
            placed_xy   = zeros(maxNodes, 2);

            for n = 1:maxNodes
                % Valid = far enough from all placed nodes
                if nPlaced == 0
                    validMask = true(M, 1);
                else
                    px   = placed_xy(1:nPlaced,1);
                    py   = placed_xy(1:nPlaced,2);
                    dMat = sqrt((candidates_xy(:,1)-px').^2 + (candidates_xy(:,2)-py').^2);
                    validMask = min(dMat,[],2) >= tau;
                end

                % Relax tau progressively if nothing qualifies
                relaxed = tau;
                while ~any(validMask) && relaxed > tau*0.25
                    relaxed   = relaxed * 0.75;
                    px   = placed_xy(1:nPlaced,1);
                    py   = placed_xy(1:nPlaced,2);
                    dMat = sqrt((candidates_xy(:,1)-px').^2 + (candidates_xy(:,2)-py').^2);
                    validMask = min(dMat,[],2) >= relaxed;
                end
                if ~any(validMask), break; end

                % Coverage gain among valid candidates
                gains = zeros(M, 1);
                if any(uncovered)
                    gains(validMask) = sum(A_mat(uncovered, validMask), 1);
                end

                if all(gains(validMask) == 0)
                    % All covered – pick most spread-out valid candidate
                    if nPlaced == 0
                        scores = sum(A_mat, 1)';
                        scores(~validMask) = -inf;
                    else
                        px   = placed_xy(1:nPlaced,1);
                        py   = placed_xy(1:nPlaced,2);
                        dMat = sqrt((candidates_xy(:,1)-px').^2 + (candidates_xy(:,2)-py').^2);
                        scores = min(dMat,[],2);
                        scores(~validMask) = -inf;
                    end
                    [~, best] = max(scores);
                else
                    [~, best] = max(gains);
                end

                nPlaced = nPlaced + 1;
                selectedIdx(nPlaced)  = best;
                placed_xy(nPlaced, :) = candidates_xy(best, :);
                uncovered(A_mat(:, best)) = false;
                if ~any(uncovered), break; end
            end

            selectedIdx = unique(selectedIdx(1:nPlaced));
        end

        % ------------------------------------------------------------------
        % Greedy minimum set cover (fallback for unconstrained ILP failure)
        % ------------------------------------------------------------------
        function selectedIdx = greedySetCover(~, A_mat)
            uncovered   = true(size(A_mat,1),1);
            selectedIdx = [];
            while any(uncovered)
                gains = sum(A_mat(uncovered,:),1);
                if all(gains==0), break; end
                [~, best] = max(gains);
                selectedIdx(end+1) = best; %#ok<AGROW>
                uncovered(A_mat(:,best)) = false;
            end
        end

        % ------------------------------------------------------------------
        % Step 7 – Strict air + boundary filter
        %   Keeps only nodes that are (a) in air pixels and
        %   (b) at least NodeCoverageRadius/2 from any image edge.
        % ------------------------------------------------------------------
        function nodes = strictAirFilter(obj, nodes, pathsMask, h_img, w_img)
            margin = max(5, round(obj.NodeCoverageRadius / 2));
            keep   = false(size(nodes,1),1);
            for i = 1:size(nodes,1)
                c = min(w_img, max(1, round(nodes(i,1))));
                r = min(h_img, max(1, round(nodes(i,2))));
                inMask   = pathsMask(r, c);
                inBounds = c > margin && c < (w_img-margin) && ...
                           r > margin && r < (h_img-margin);
                if inMask && inBounds, keep(i) = true; end
            end
            if any(keep), nodes = nodes(keep,:); end
        end

        % ------------------------------------------------------------------
        % Step 8 – RF sector pruning (unconstrained mode only)
        % ------------------------------------------------------------------
        function nodes = rfSectorPrune(obj, nodes, heatImg, tx, ty, w_img, h_img)
            if isempty(nodes), return; end
            [X_grid, Y_grid] = meshgrid(1:w_img, 1:h_img);
            pixAngles  = mod(atan2d(Y_grid-ty, X_grid-tx), 360);
            nodeAngles = mod(atan2d(nodes(:,2)-ty, nodes(:,1)-tx), 360);
            keepNode   = true(size(nodes,1),1);
            for aS = 0:obj.SectorAngleDelta:(360-obj.SectorAngleDelta)
                aE    = aS + obj.SectorAngleDelta;
                inSec = find(nodeAngles >= aS & nodeAngles < aE);
                if isempty(inSec), continue; end
                sectorVals = heatImg(pixAngles >= aS & pixAngles < aE);
                if std(sectorVals) > obj.StdDeviationThreshold
                    for ni = inSec'
                        nx = min(w_img, max(1, round(nodes(ni,1))));
                        ny = min(h_img, max(1, round(nodes(ni,2))));
                        if heatImg(ny,nx) > obj.StrongSignalThreshold
                            keepNode(ni) = false;
                        end
                    end
                end
            end
            filtered = nodes(keepNode,:);
            if ~isempty(filtered), nodes = filtered; end
        end

        % ------------------------------------------------------------------
        % Step 9 – Spatial diversity enforcement (unconstrained mode only)
        % ------------------------------------------------------------------
        function nodes = spatialDiversityEnforce(obj, nodes)
            if isempty(nodes), return; end
            kept = nodes(1,:);
            for i = 2:size(nodes,1)
                if all(sqrt(sum((kept - nodes(i,:)).^2, 2)) > obj.MinDistPruning)
                    kept = [kept; nodes(i,:)]; %#ok<AGROW>
                end
            end
            if ~isempty(kept), nodes = kept; end
        end

        % ------------------------------------------------------------------
        % Post-placement fitness: remove nodes that add zero new coverage
        %   Fitness_j = CoverageGain_j - lambda*Interference_j
        %   Remove node if CoverageGain_j == 0.
        % ------------------------------------------------------------------
        function nodes = removZeroGainNodes(obj, nodes, clusters)
            if isempty(nodes) || isempty(clusters), return; end
            N     = size(nodes, 1);
            keep  = true(N, 1);
            cx    = [clusters.cx]';
            cy    = [clusters.cy]';

            for i = 1:N
                % Check if removing this node leaves all its clusters
                % covered by another node
                others = nodes(setdiff(1:N, i), :);
                if isempty(others)
                    keep(i) = true;  % last node – always keep
                    continue;
                end
                % Which clusters does node i cover?
                di = sqrt((cx - nodes(i,1)).^2 + (cy - nodes(i,2)).^2);
                myClusters = di <= obj.NodeCoverageRadius;
                if ~any(myClusters)
                    keep(i) = false;  % covers nothing – remove
                    continue;
                end
                % Are all of node i's clusters already covered by others?
                covByOther = false(sum(myClusters), 1);
                myCx = cx(myClusters);  myCy = cy(myClusters);
                for o = 1:size(others,1)
                    do = sqrt((myCx - others(o,1)).^2 + (myCy - others(o,2)).^2);
                    covByOther(do <= obj.NodeCoverageRadius) = true;
                end
                if all(covByOther)
                    keep(i) = false;  % purely redundant – remove
                end
            end

            if any(keep), nodes = nodes(keep,:); end
        end

        % ------------------------------------------------------------------
        % Coverage fraction helper
        % ------------------------------------------------------------------
        function frac = computeCoverage(obj, nodes, clusters)
            K = length(clusters);
            if K == 0 || isempty(nodes)
                frac = 0; return;
            end
            cx = [clusters.cx]';  cy = [clusters.cy]';
            covered = false(K,1);
            for i = 1:size(nodes,1)
                d = sqrt((cx-nodes(i,1)).^2 + (cy-nodes(i,2)).^2);
                covered(d <= obj.NodeCoverageRadius) = true;
            end
            frac = sum(covered) / K;
        end

        % ------------------------------------------------------------------
        % Empty result helper
        % ------------------------------------------------------------------
        function result = emptyResult(~, img, transmitter, heatImg, buildMask, deadZoneMask)
            result.img                = img;
            result.transmitter        = transmitter;
            result.bestR              = 0;
            result.heatImg            = heatImg;
            result.binaryMask         = buildMask;
            result.deadZoneMask       = deadZoneMask;
            result.candidateLocations = zeros(0,2);
            result.clusterCentroids   = zeros(0,2);
            result.adjacency          = [];
            result.nodesBeforeOpt     = zeros(0,2);
            result.finalNodes         = zeros(0,2);
            result.coverageFraction   = 0;
        end

    end  % private methods

end  % classdef
