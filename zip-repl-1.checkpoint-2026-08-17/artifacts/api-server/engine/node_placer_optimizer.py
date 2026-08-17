"""
Faithful Python port of attached_assets/NodePlacerOptimizer_1784764881666.m.

This module intentionally follows the MATLAB class method-by-method.  SciPy
is used only as the numerical backend for MATLAB's `intlinprog` models;
constraints, objectives, processing order, fallbacks, and post-processing
are kept from the MATLAB source.

The public result keys retain the existing Stage 2/3 API-facing convention.
Coordinates retain the MATLAB implementation's [X, Y] image-space meaning
(one-based pixel coordinates).
"""

import numpy as np
import cv2
from scipy import ndimage, sparse
from scipy.optimize import Bounds, LinearConstraint, milp


def _matlab_round(value):
    """MATLAB round for the non-negative image coordinates used here."""
    return int(np.floor(float(value) + 0.5))


class NodePlacerOptimizer:
    """NodePlacerOptimizer translated from the supplied MATLAB class."""

    def __init__(self):
        # MATLAB properties, in the same order and with the same defaults.
        self.DeadZoneThreshold_dBm = -60
        self.MinClusterAreaPx = 20
        self.ImageScaleFactor = 1.0
        self.RadiiToTest = np.arange(20, 121, 10)
        self.MaxCandidates = 300
        self.CoverageRatio_target = 0.80
        self.NodeCoverageRadius = 50
        self.NumSectors = 12
        self.MinDistPruning = 70
        self.SectorAngleDelta = 5
        self.StdDeviationThreshold = 10
        self.StrongSignalThreshold = -18
        self.MaxNodes = 0
        self.radius_sweep_log = []

    # =====================================================================
    # Public methods
    # =====================================================================

    def run(self, campusImg, stage1_out, binaryMask):
        """Port of MATLAB `run`."""
        mag_db = np.asarray(stage1_out["mag_db"])
        src_x = stage1_out["src_x"]
        src_y = stage1_out["src_y"]

        if src_x is None or src_y is None:
            raise ValueError(
                f"Transmitter position is None: src_x={src_x}, src_y={src_y}. "
                "Ensure Stage 1 completed successfully before running Stage 2."
            )

        h_heat, w_heat = mag_db.shape

        # MATLAB: img = imresize(campusImg, ImageScaleFactor).
        img = np.asarray(campusImg)
        if self.ImageScaleFactor != 1.0:
            h_img = _matlab_round(img.shape[0] * self.ImageScaleFactor)
            w_img = _matlab_round(img.shape[1] * self.ImageScaleFactor)
            img = cv2.resize(img, (w_img, h_img), interpolation=cv2.INTER_LINEAR)
        h_img, w_img = img.shape[:2]

        # MATLAB maps the Stage 1 source coordinates into image space.
        tx = _matlab_round((src_x / w_heat) * w_img)
        ty = _matlab_round((src_y / h_heat) * h_img)
        tx = max(1, min(w_img, tx))
        ty = max(1, min(h_img, ty))

        # MATLAB: supplied mask is resized to image dimensions and thresholded.
        if binaryMask is not None and np.size(binaryMask) != 0:
            mask = np.asarray(binaryMask)
            if mask.shape != (h_img, w_img):
                mask = cv2.resize(
                    mask.astype(np.float32),
                    (w_img, h_img),
                    interpolation=cv2.INTER_CUBIC,
                )
            buildMask = mask > 0.5
        else:
            # This branch mirrors MATLAB's automatic mask path as closely as
            # possible.  Production Stage 2 always supplies the persisted ROI
            # mask, so this is retained for API compatibility.
            rgb = img[:, :, :3]
            gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
            threshold = _graythresh(gray) * 255.0 * 0.8
            buildMask = gray > threshold
        pathsMask = ~buildMask

        # MATLAB resizes the heatmap once to image space.
        if mag_db.shape != (h_img, w_img):
            heatImg = cv2.resize(
                mag_db.astype(np.float32),
                (w_img, h_img),
                interpolation=cv2.INTER_CUBIC,
            )
        else:
            heatImg = mag_db.copy()

        # Step 1: dead-zone extraction and clustering.
        clusters, numClusters, deadZoneMask = self.extractClusters(heatImg)
        if numClusters == 0:
            return self.emptyResult(
                img, [tx, ty], heatImg, buildMask,
                np.zeros((h_img, w_img), dtype=bool),
            )

        # Step 2: polar transformation.
        clusters = self.polarTransform(clusters, tx, ty)

        # Step 3: candidate location generation.
        candidates_xy, bestR, fullCandidates = self.generateCandidates(
            pathsMask, clusters, tx, ty, h_img, w_img
        )
        if len(candidates_xy) == 0:
            return self.emptyResult(
                img, [tx, ty], heatImg, buildMask, deadZoneMask
            )

        # Step 4: sector mapping.
        clusterSectors, activeSectors = self.mapSectors(clusters)

        # Step 5: adjacency.
        A_mat = self.buildAdjacency(clusters, candidates_xy)

        # Step 6: solve exactly the MATLAB branch selected by MaxNodes.
        if self.MaxNodes > 0:
            selectedIdx, covFracILP = self.solveBudgetILP(
                A_mat, candidates_xy, clusters, tx, ty, self.MaxNodes
            )
        else:
            covFracILP = None
            selectedIdx = self.solveMinCoverILP(
                A_mat, candidates_xy, clusters,
                clusterSectors, activeSectors, tx, ty
            )
        placedNodes = candidates_xy[np.asarray(selectedIdx, dtype=int)] if len(selectedIdx) else np.zeros((0, 2))

        # Step 7: strict air and boundary filter.
        placedNodes = self.strictAirFilter(placedNodes, pathsMask, h_img, w_img)
        nodesBeforeOpt = placedNodes.copy()

        # Steps 8-9: only in unconstrained mode.
        if self.MaxNodes == 0:
            placedNodes = self.rfSectorPrune(
                placedNodes, heatImg, tx, ty, w_img, h_img
            )
            placedNodes = self.spatialDiversityEnforce(placedNodes)

        # MATLAB's budget branch applies this post-placement step.
        if self.MaxNodes > 0 and len(placedNodes):
            placedNodes = self.removZeroGainNodes(placedNodes, clusters)

        coverageFraction = self.computeCoverage(placedNodes, clusters)

        return {
            "img": img,
            "transmitter": [tx, ty],
            "bestR": bestR,
            "heatImg": heatImg,
            "binaryMask": buildMask,
            "deadZoneMask": deadZoneMask,
            "candidateLocations": fullCandidates,
            "clusterCentroids": np.array(
                [[c["cx"], c["cy"]] for c in clusters], dtype=float
            ),
            "adjacency": A_mat,
            "nodesBeforeOpt": nodesBeforeOpt,
            "finalNodes": placedNodes,
            "coverageFraction": coverageFraction,
            # Retained for callers that used the previous internal result.
            "mag_db": heatImg,
            "covFracILP": covFracILP,
            "radiusSweep": [list(point) for point in self.radius_sweep_log],
        }

    def runBudget(self, mainResult, maxNodes):
        """Port of MATLAB `runBudget` using fixed Stage 2 node positions."""
        finalNodes = _xy_array(mainResult.get("finalNodes", []))
        n = finalNodes.shape[0]

        if n == 0:
            budgetResult = dict(mainResult)
            budgetResult["finalNodes"] = np.zeros((0, 2))
            budgetResult["coverageFraction"] = 0
            return budgetResult

        if maxNodes >= n:
            return dict(mainResult)

        cc = _xy_array(mainResult.get("clusterCentroids", []))
        clusters = [
            {
                "cx": float(row[0]),
                "cy": float(row[1]),
                "area": 1,
                "meanRSSI": 0,
                "r": 0,
                "theta": 0,
            }
            for row in cc
        ]

        A_mat = self.buildAdjacency(clusters, finalNodes)
        selectedNodes = self.backwardElimination(
            finalNodes, A_mat, len(clusters), maxNodes
        )
        covFrac = self.computeCoverage(selectedNodes, clusters)

        budgetResult = dict(mainResult)
        budgetResult["finalNodes"] = selectedNodes
        budgetResult["nodesBeforeOpt"] = selectedNodes
        budgetResult["coverageFraction"] = covFrac
        return budgetResult

    # =====================================================================
    # MATLAB private methods: steps 1-5
    # =====================================================================

    def extractClusters(self, heatImg):
        """Port of MATLAB `extractClusters` and `bwconncomp(..., 8)`."""
        deadZoneMask = np.asarray(heatImg) < self.DeadZoneThreshold_dBm
        connectivity = np.ones((3, 3), dtype=np.uint8)
        labels, count = ndimage.label(deadZoneMask, structure=connectivity)

        # bwconncomp scans MATLAB arrays in column-major order.  scipy labels
        # components while scanning row-major, so reorder the component IDs by
        # their first MATLAB-linear pixel before building regionprops-like
        # records.
        component_order = []
        for k in range(1, count + 1):
            pixel_rows, pixel_cols = np.where(labels == k)
            if pixel_rows.size:
                first_linear = int(np.min(
                    pixel_rows + pixel_cols * heatImg.shape[0]
                ))
                component_order.append((first_linear, k))
        component_order.sort()

        clusters = []
        for _, k in component_order:
            pixel_idx = np.flatnonzero(labels == k)
            area = int(pixel_idx.size)
            if area < self.MinClusterAreaPx:
                continue

            # MATLAB regionprops Centroid is one-based [X,Y].  The array
            # indices are recovered in MATLAB's column-major order.
            rows0, cols0 = np.where(labels == k)
            clusters.append({
                "cx": float(cols0.mean() + 1),
                "cy": float(rows0.mean() + 1),
                "area": area,
                "meanRSSI": float(np.mean(np.asarray(heatImg)[rows0, cols0])),
                "r": 0.0,
                "theta": 0.0,
            })
        return clusters, len(clusters), deadZoneMask

    def polarTransform(self, clusters, tx, ty):
        """Port of MATLAB `polarTransform`."""
        for cluster in clusters:
            dx = cluster["cx"] - tx
            dy = cluster["cy"] - ty
            cluster["r"] = float(np.sqrt(dx * dx + dy * dy))
            cluster["theta"] = float(np.mod(np.degrees(np.arctan2(dy, dx)), 360))
        return clusters

    def generateCandidates(self, pathsMask, clusters, tx, ty, h_img, w_img):
        """Port of MATLAB `generateCandidates`."""
        margin = max(5, _matlab_round(self.NodeCoverageRadius / 2))
        edgeMask = np.zeros((h_img, w_img), dtype=bool)
        # MATLAB: margin+1:h_img-margin, margin+1:w_img-margin.
        if h_img - margin >= margin + 1 and w_img - margin >= margin + 1:
            edgeMask[margin:h_img - margin, margin:w_img - margin] = True
        interiorMask = np.asarray(pathsMask, dtype=bool) & edgeMask

        # MATLAB find() is column-major and returns one-based row/column.
        pixel_idx = np.flatnonzero(interiorMask.ravel(order="F"))
        rows0, cols0 = np.unravel_index(pixel_idx, (h_img, w_img), order="F")
        L_pool = np.column_stack((cols0 + 1, rows0 + 1)).astype(float)

        if L_pool.shape[0] == 0:
            pixel_idx = np.flatnonzero(np.asarray(pathsMask).ravel(order="F"))
            rows0, cols0 = np.unravel_index(pixel_idx, (h_img, w_img), order="F")
            L_pool = np.column_stack((cols0 + 1, rows0 + 1)).astype(float)
        if L_pool.shape[0] == 0:
            L_pool = np.array([[_matlab_round(w_img / 2), _matlab_round(h_img / 2)]], dtype=float)

        fullCandidates = L_pool.copy()
        D_xy = np.array([[c["cx"], c["cy"]] for c in clusters], dtype=float)
        k = len(clusters)
        bestR = int(self.RadiiToTest[0])
        minNodes = np.inf
        self.radius_sweep_log = []

        for radius in self.RadiiToTest:
            distTx = np.sqrt(
                (L_pool[:, 0] - tx) ** 2 + (L_pool[:, 1] - ty) ** 2
            )
            validPool = L_pool[distTx >= radius, :]
            if validPool.shape[0] == 0:
                continue

            step = max(1, int(np.floor(validPool.shape[0] / 120)))
            L_sub = validPool[::step, :]

            A_temp = np.zeros((k, L_sub.shape[0]), dtype=bool)
            for j in range(L_sub.shape[0]):
                d = np.sqrt(
                    (D_xy[:, 0] - L_sub[j, 0]) ** 2
                    + (D_xy[:, 1] - L_sub[j, 1]) ** 2
                )
                A_temp[d <= self.NodeCoverageRadius, j] = True

            coverable = np.any(A_temp, axis=1)
            covRatio = np.sum(coverable) / k
            uncovered = coverable.copy()
            estNodes = 0
            while np.any(uncovered):
                uncovered_idx = np.flatnonzero(uncovered)
                gains = np.sum(A_temp[uncovered_idx, :], axis=0)
                best_idx = int(np.argmax(gains))
                if gains[best_idx] <= 0:
                    break
                uncovered[uncovered_idx[A_temp[uncovered_idx, best_idx]]] = False
                estNodes += 1
            self.radius_sweep_log.append(
                (float(radius), estNodes, float(covRatio * 100.0))
            )
            if covRatio >= self.CoverageRatio_target and estNodes < minNodes:
                minNodes = estNodes
                bestR = int(radius)

        distTx = np.sqrt(
            (L_pool[:, 0] - tx) ** 2 + (L_pool[:, 1] - ty) ** 2
        )
        finalPool = L_pool[distTx >= bestR, :]
        if finalPool.shape[0] == 0:
            finalPool = L_pool

        step = max(1, int(np.floor(finalPool.shape[0] / self.MaxCandidates)))
        candidates_xy = finalPool[::step, :]
        return candidates_xy, bestR, fullCandidates

    def mapSectors(self, clusters):
        """Port of MATLAB `mapSectors`."""
        deltaTh = 360 / self.NumSectors
        clusterSectors = np.zeros(len(clusters), dtype=int)
        for k, cluster in enumerate(clusters):
            clusterSectors[k] = min(
                int(np.floor(cluster["theta"] / deltaTh)) + 1,
                self.NumSectors,
            )
        activeSectors = np.unique(clusterSectors)
        return clusterSectors, activeSectors

    def buildAdjacency(self, clusters, candidates_xy):
        """Port of MATLAB `buildAdjacency`."""
        candidates_xy = _xy_array(candidates_xy)
        adjacency = np.zeros((len(clusters), candidates_xy.shape[0]), dtype=bool)
        for j in range(candidates_xy.shape[0]):
            dx = np.array([c["cx"] for c in clusters]) - candidates_xy[j, 0]
            dy = np.array([c["cy"] for c in clusters]) - candidates_xy[j, 1]
            adjacency[:, j] = np.sqrt(dx * dx + dy * dy) <= self.NodeCoverageRadius
        return adjacency

    # =====================================================================
    # MATLAB private methods: step 6
    # =====================================================================

    def solveBudgetILP(self, A_mat, candidates_xy, clusters, tx, ty, maxNodes):
        """Port of MATLAB `solveBudgetILP`."""
        A_mat = np.asarray(A_mat, dtype=bool)
        candidates_xy = _xy_array(candidates_xy)
        k, m = A_mat.shape
        tau = self.NodeCoverageRadius
        nVars = m + k

        # C1: sum(x) <= maxNodes.
        rows = [sparse.csr_matrix(np.r_[np.ones(m), np.zeros(k)][None, :])]
        lower = [-np.inf]
        upper = [maxNodes]

        # C2: [-A | I] z <= 0.
        rows.append(sparse.hstack([-sparse.csr_matrix(A_mat.astype(float)), sparse.eye(k)]))
        lower.extend([-np.inf] * k)
        upper.extend([0.0] * k)

        # C3: x_j + x_k <= 1 for every pair with distance < tau.
        dx_pair = candidates_xy[:, 0, None] - candidates_xy[None, :, 0]
        dy_pair = candidates_xy[:, 1, None] - candidates_xy[None, :, 1]
        pairD = np.sqrt(dx_pair * dx_pair + dy_pair * dy_pair)
        jIdx, kIdx = np.where(np.triu(pairD < tau, 1))
        if len(jIdx):
            pair_rows = np.arange(len(jIdx))
            A_c3 = sparse.coo_matrix(
                (
                    np.ones(len(jIdx) * 2),
                    (
                        np.repeat(pair_rows, 2),
                        np.column_stack((jIdx, kIdx)).ravel(),
                    ),
                ),
                shape=(len(jIdx), nVars),
            ).tocsr()
            rows.append(A_c3)
            lower.extend([-np.inf] * len(jIdx))
            upper.extend([1.0] * len(jIdx))

        # C4: candidate-sector anti-clustering.
        k_sec = self.NumSectors
        maxPerSec = int(np.ceil(maxNodes / k_sec))
        deltaTh = 360 / k_sec
        candAngles = np.mod(
            np.degrees(np.arctan2(candidates_xy[:, 1] - ty, candidates_xy[:, 0] - tx)),
            360,
        )
        c4_rows = []
        for s in range(1, k_sec + 1):
            aMin = (s - 1) * deltaTh
            aMax = s * deltaTh
            inSec = np.flatnonzero((candAngles >= aMin) & (candAngles < aMax))
            if len(inSec) > maxPerSec:
                row = np.zeros(nVars)
                row[inSec] = 1
                c4_rows.append(row)
        if c4_rows:
            rows.append(sparse.csr_matrix(np.asarray(c4_rows)))
            lower.extend([-np.inf] * len(c4_rows))
            upper.extend([float(maxPerSec)] * len(c4_rows))

        A_ineq = sparse.vstack(rows, format="csr")
        f = np.r_[np.zeros(m), -np.ones(k)]
        result = milp(
            c=f,
            integrality=np.ones(nVars),
            bounds=Bounds(np.zeros(nVars), np.ones(nVars)),
            constraints=LinearConstraint(
                A_ineq, np.asarray(lower), np.asarray(upper)
            ),
            options={"time_limit": 120},
        )

        if result.success and result.x is not None:
            selectedIdx = np.flatnonzero(result.x[:m] > 0.5)
            covFrac = float(np.sum(result.x[m:] > 0.5) / k) if k else 0
        else:
            selectedIdx = self.greedyBudgetSpread(
                A_mat, candidates_xy, maxNodes, tau
            )
            covFrac = self.computeCoverage(
                candidates_xy[selectedIdx, :] if len(selectedIdx) else np.zeros((0, 2)),
                clusters,
            )

        if len(selectedIdx) == 0:
            selectedIdx = np.arange(min(maxNodes, m), dtype=int)
            covFrac = 0
        return selectedIdx, covFrac

    def solveMinCoverILP(
        self, A_mat, candidates_xy, clusters, clusterSectors, activeSectors, tx, ty
    ):
        """Port of MATLAB `solveMinCoverILP`."""
        A_mat = np.asarray(A_mat, dtype=bool)
        candidates_xy = _xy_array(candidates_xy)
        m = A_mat.shape[1]

        rowsCovered = np.flatnonzero(np.any(A_mat, axis=1))
        A_c1 = sparse.csr_matrix(A_mat[rowsCovered].astype(float))
        lower = np.ones(len(rowsCovered))
        upper = np.full(len(rowsCovered), np.inf)

        deltaTh = 360 / self.NumSectors
        candAngles = np.mod(
            np.degrees(np.arctan2(candidates_xy[:, 1] - ty, candidates_xy[:, 0] - tx)),
            360,
        )
        candSec = np.minimum(
            np.floor(candAngles / deltaTh).astype(int) + 1,
            self.NumSectors,
        )

        b_sec = []
        for sector in np.asarray(activeSectors, dtype=int):
            b_sec.append((candSec == sector).astype(float))
        if b_sec:
            B_sec = np.asarray(b_sec)
            validSec = np.any(B_sec, axis=1)
            B_sec_valid = sparse.csr_matrix(B_sec[validSec])
            rows = sparse.vstack([A_c1, B_sec_valid], format="csr")
            lower = np.r_[lower, np.ones(int(np.sum(validSec)))]
            upper = np.full(rows.shape[0], np.inf)
        else:
            rows = A_c1

        result = milp(
            c=np.ones(m),
            integrality=np.ones(m),
            bounds=Bounds(np.zeros(m), np.ones(m)),
            constraints=LinearConstraint(rows, lower, upper),
            options={"time_limit": 120},
        )
        if result.success and result.x is not None:
            selectedIdx = np.flatnonzero(result.x > 0.5)
        else:
            selectedIdx = self.greedySetCover(A_mat)
        if len(selectedIdx) == 0:
            selectedIdx = np.arange(min(10, m), dtype=int)
        return selectedIdx

    def backwardElimination(self, finalNodes, A_mat, K, maxNodes):
        """Port of MATLAB `backwardElimination`."""
        finalNodes = _xy_array(finalNodes)
        n = finalNodes.shape[0]
        if maxNodes >= n:
            return finalNodes

        active = np.ones(n, dtype=bool)
        while int(np.sum(active)) > maxNodes:
            activeIdx = np.flatnonzero(active)
            covNow = int(np.sum(np.any(A_mat[:, active], axis=1))) if K else 0
            minLoss = np.inf
            dropNode = int(activeIdx[0])

            for j in activeIdx:
                active[j] = False
                covWithout = int(np.sum(np.any(A_mat[:, active], axis=1))) if K else 0
                active[j] = True
                loss = covNow - covWithout
                if loss < minLoss:
                    minLoss = loss
                    dropNode = int(j)
            active[dropNode] = False
        return finalNodes[active, :]

    def selectBestSubsetILP(self, A_mat, N, K, maxNodes):
        """MATLAB helper retained for compatibility; runBudget uses backward elimination."""
        A_mat = np.asarray(A_mat, dtype=bool)
        nVars = N + K
        rows = [
            sparse.csr_matrix(np.r_[np.ones(N), np.zeros(K)][None, :]),
            sparse.hstack([-sparse.csr_matrix(A_mat.astype(float)), sparse.eye(K)]),
        ]
        lower = [-np.inf] + [-np.inf] * K
        upper = [maxNodes] + [0.0] * K
        result = milp(
            c=np.r_[np.zeros(N), -np.ones(K)],
            integrality=np.ones(nVars),
            bounds=Bounds(np.zeros(nVars), np.ones(nVars)),
            constraints=LinearConstraint(
                sparse.vstack(rows, format="csr"),
                np.asarray(lower),
                np.asarray(upper),
            ),
            options={"time_limit": 60},
        )
        if result.success and result.x is not None:
            selectedIdx = np.flatnonzero(result.x[:N] > 0.5)
            covFrac = float(np.sum(result.x[N:] > 0.5) / K) if K else 0
        else:
            uncovered = np.ones(K, dtype=bool)
            selected = []
            for _ in range(maxNodes):
                gains = np.sum(A_mat[uncovered, :], axis=0)
                if np.all(gains == 0):
                    break
                best = int(np.argmax(gains))
                selected.append(best)
                uncovered[A_mat[:, best]] = False
                if not np.any(uncovered):
                    break
            selectedIdx = np.asarray(selected, dtype=int)
            covFrac = float(np.sum(~uncovered) / K) if K else 0
        if len(selectedIdx) == 0:
            selectedIdx = np.arange(min(maxNodes, N), dtype=int)
            covFrac = 0
        return selectedIdx, covFrac

    def greedyBudgetSpread(self, A_mat, candidates_xy, maxNodes, tau):
        """Port of MATLAB `greedyBudgetSpread`."""
        A_mat = np.asarray(A_mat, dtype=bool)
        candidates_xy = _xy_array(candidates_xy)
        m = candidates_xy.shape[0]
        k = A_mat.shape[0]
        uncovered = np.ones(k, dtype=bool)
        selectedIdx = np.zeros(maxNodes, dtype=int)
        nPlaced = 0
        placed_xy = np.zeros((maxNodes, 2), dtype=float)

        for _ in range(maxNodes):
            if nPlaced == 0:
                validMask = np.ones(m, dtype=bool)
            else:
                dmat = np.sqrt(
                    (candidates_xy[:, 0, None] - placed_xy[:nPlaced, 0][None, :]) ** 2
                    + (candidates_xy[:, 1, None] - placed_xy[:nPlaced, 1][None, :]) ** 2
                )
                validMask = np.min(dmat, axis=1) >= tau

            relaxed = tau
            while not np.any(validMask) and relaxed > tau * 0.25:
                relaxed *= 0.75
                dmat = np.sqrt(
                    (candidates_xy[:, 0, None] - placed_xy[:nPlaced, 0][None, :]) ** 2
                    + (candidates_xy[:, 1, None] - placed_xy[:nPlaced, 1][None, :]) ** 2
                )
                validMask = np.min(dmat, axis=1) >= relaxed
            if not np.any(validMask):
                break

            gains = np.zeros(m)
            if np.any(uncovered):
                gains[validMask] = np.sum(A_mat[uncovered][:, validMask], axis=0)

            if np.all(gains[validMask] == 0):
                if nPlaced == 0:
                    scores = np.sum(A_mat, axis=0).astype(float)
                    scores[~validMask] = -np.inf
                else:
                    scores = np.min(dmat, axis=1)
                    scores[~validMask] = -np.inf
                best = int(np.argmax(scores))
            else:
                best = int(np.argmax(gains))

            selectedIdx[nPlaced] = best
            placed_xy[nPlaced, :] = candidates_xy[best, :]
            nPlaced += 1
            uncovered[A_mat[:, best]] = False
            if not np.any(uncovered):
                break

        return np.unique(selectedIdx[:nPlaced])

    def greedySetCover(self, A_mat):
        """Port of MATLAB `greedySetCover`."""
        A_mat = np.asarray(A_mat, dtype=bool)
        uncovered = np.ones(A_mat.shape[0], dtype=bool)
        selectedIdx = []
        while np.any(uncovered):
            gains = np.sum(A_mat[uncovered, :], axis=0)
            if np.all(gains == 0):
                break
            best = int(np.argmax(gains))
            selectedIdx.append(best)
            uncovered[A_mat[:, best]] = False
        return np.asarray(selectedIdx, dtype=int)

    # =====================================================================
    # MATLAB private methods: steps 7-9 and helpers
    # =====================================================================

    def strictAirFilter(self, nodes, pathsMask, h_img, w_img):
        """Port of MATLAB `strictAirFilter`."""
        nodes = _xy_array(nodes)
        margin = max(5, _matlab_round(self.NodeCoverageRadius / 2))
        keep = np.zeros(nodes.shape[0], dtype=bool)
        for i, node in enumerate(nodes):
            c = min(w_img, max(1, _matlab_round(node[0])))
            r = min(h_img, max(1, _matlab_round(node[1])))
            inMask = bool(pathsMask[r - 1, c - 1])
            inBounds = (
                c > margin and c < (w_img - margin)
                and r > margin and r < (h_img - margin)
            )
            if inMask and inBounds:
                keep[i] = True
        # MATLAB only replaces the input if at least one node survives.
        return nodes[keep, :] if np.any(keep) else nodes

    def rfSectorPrune(self, nodes, heatImg, tx, ty, w_img, h_img):
        """Port of MATLAB `rfSectorPrune`."""
        nodes = _xy_array(nodes)
        if nodes.shape[0] == 0:
            return nodes

        x_grid, y_grid = np.meshgrid(
            np.arange(1, w_img + 1), np.arange(1, h_img + 1)
        )
        pixAngles = np.mod(np.degrees(np.arctan2(y_grid - ty, x_grid - tx)), 360)
        nodeAngles = np.mod(
            np.degrees(np.arctan2(nodes[:, 1] - ty, nodes[:, 0] - tx)), 360
        )
        keepNode = np.ones(nodes.shape[0], dtype=bool)
        for aS in np.arange(0, 360, self.SectorAngleDelta):
            aE = aS + self.SectorAngleDelta
            inSec = np.flatnonzero((nodeAngles >= aS) & (nodeAngles < aE))
            if len(inSec) == 0:
                continue
            sectorVals = heatImg[(pixAngles >= aS) & (pixAngles < aE)]
            sectorStd = np.std(sectorVals, ddof=1) if sectorVals.size > 1 else np.nan
            if sectorStd > self.StdDeviationThreshold:
                for ni in inSec:
                    nx = min(w_img, max(1, _matlab_round(nodes[ni, 0])))
                    ny = min(h_img, max(1, _matlab_round(nodes[ni, 1])))
                    if heatImg[ny - 1, nx - 1] > self.StrongSignalThreshold:
                        keepNode[ni] = False
        filtered = nodes[keepNode, :]
        return filtered if filtered.shape[0] else nodes

    def spatialDiversityEnforce(self, nodes):
        """Port of MATLAB `spatialDiversityEnforce`."""
        nodes = _xy_array(nodes)
        if nodes.shape[0] == 0:
            return nodes
        kept = [nodes[0].copy()]
        for i in range(1, nodes.shape[0]):
            distances = np.sqrt(np.sum((np.asarray(kept) - nodes[i]) ** 2, axis=1))
            if np.all(distances > self.MinDistPruning):
                kept.append(nodes[i].copy())
        return np.asarray(kept)

    def removZeroGainNodes(self, nodes, clusters):
        """Port of MATLAB's intentionally named `removZeroGainNodes`."""
        nodes = _xy_array(nodes)
        if nodes.shape[0] == 0 or len(clusters) == 0:
            return nodes
        n = nodes.shape[0]
        keep = np.ones(n, dtype=bool)
        cx = np.array([c["cx"] for c in clusters])
        cy = np.array([c["cy"] for c in clusters])

        for i in range(n):
            others = nodes[np.arange(n) != i, :]
            if others.shape[0] == 0:
                keep[i] = True
                continue
            di = np.sqrt((cx - nodes[i, 0]) ** 2 + (cy - nodes[i, 1]) ** 2)
            myClusters = di <= self.NodeCoverageRadius
            if not np.any(myClusters):
                keep[i] = False
                continue
            myCx = cx[myClusters]
            myCy = cy[myClusters]
            covByOther = np.zeros(myCx.shape[0], dtype=bool)
            for other in others:
                do = np.sqrt((myCx - other[0]) ** 2 + (myCy - other[1]) ** 2)
                covByOther[do <= self.NodeCoverageRadius] = True
            if np.all(covByOther):
                keep[i] = False
        return nodes[keep, :] if np.any(keep) else nodes

    def computeCoverage(self, nodes, clusters):
        """Port of MATLAB `computeCoverage`."""
        nodes = _xy_array(nodes)
        k = len(clusters)
        if k == 0 or nodes.shape[0] == 0:
            return 0
        cx = np.array([c["cx"] for c in clusters])
        cy = np.array([c["cy"] for c in clusters])
        covered = np.zeros(k, dtype=bool)
        for node in nodes:
            d = np.sqrt((cx - node[0]) ** 2 + (cy - node[1]) ** 2)
            covered[d <= self.NodeCoverageRadius] = True
        return float(np.sum(covered) / k)

    def emptyResult(self, img, transmitter, heatImg, buildMask, deadZoneMask):
        """Port of MATLAB `emptyResult`."""
        return {
            "img": img,
            "transmitter": transmitter,
            "bestR": 0,
            "heatImg": heatImg,
            "binaryMask": buildMask,
            "deadZoneMask": deadZoneMask,
            "candidateLocations": np.zeros((0, 2)),
            "clusterCentroids": np.zeros((0, 2)),
            "adjacency": np.zeros((0, 0), dtype=bool),
            "nodesBeforeOpt": np.zeros((0, 2)),
            "finalNodes": np.zeros((0, 2)),
            "coverageFraction": 0,
            "mag_db": heatImg,
            "radiusSweep": [list(point) for point in self.radius_sweep_log],
        }


def _xy_array(value):
    arr = np.asarray(value, dtype=float)
    if arr.size == 0:
        return np.zeros((0, 2), dtype=float)
    return arr.reshape((-1, 2))


def _graythresh(gray):
    """Small direct implementation of MATLAB graythresh/Otsu threshold."""
    values = np.asarray(gray, dtype=np.uint8).ravel()
    hist = np.bincount(values, minlength=256).astype(float)
    probability = hist / max(1, values.size)
    omega = np.cumsum(probability)
    mu = np.cumsum(probability * np.arange(256))
    mu_t = mu[-1]
    denominator = omega * (1 - omega)
    numerator = (mu_t * omega - mu) ** 2
    sigma = np.divide(
        numerator, denominator,
        out=np.zeros_like(numerator),
        where=denominator > 0,
    )
    return float(np.argmax(sigma) / 255.0)
