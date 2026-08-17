---
name: Notebook optimizer configuration
description: Configuration steps outside the optimizer class that are required for parity with the reference notebook
---

Reference notebooks may configure an otherwise matching algorithm immediately before execution. The production pipeline must reproduce those parameter assignments, not only copy the optimizer class.

**Why:** The node-placement class matched the reference implementation, but production initially retained its standalone `-50 dBm` fallback instead of applying the notebook's 35th-percentile RSSI threshold. On the same cropped input, that changed the result from one node to two.

**How to apply:** When porting or auditing a notebook, compare the setup/run cell as well as the class body. Persist resolved configuration values when they affect reproducibility or result interpretation.