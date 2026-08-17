import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stage1Router from "./stage1";
import stage2Router from "./stage2";
import stage3Router from "./stage3";
import stage4Router from "./stage4";
import stage5Router from "./stage5";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stage1Router);
router.use(stage2Router);
router.use(stage3Router);
router.use(stage4Router);
router.use(stage5Router);

export default router;
