# MFEM 4.10 - retained adaptive elasticity references

This directory is a reduced reference archive of the downloaded MFEM 4.10 source, not a buildable MFEM distribution. The application does not link against MFEM. Its adapted implementation is ../src/core/adaptive-mesh.js; usage and numerical differences are documented in ../docs/ADAPTIVE_MESH.md.

Retained files:

- examples/ex10.cpp, examples/ex23.cpp and reference/newmark-step.cpp: dynamic elasticity, waves and Newmark time stepping used to adapt the native blast solver. See ../docs/BLAST_DYNAMICS.md and reference/blast-source-manifest.json. Cavity loading and damage are application additions.

- examples/ex21.cpp: original adaptive linear elasticity example.
- reference/flux-averaging.cpp: original GridFunction::ComputeFlux averaging.
- reference/zz-estimator.cpp: original ZZErrorEstimator.
- reference/elasticity-flux-energy.cpp: original elasticity error-energy integration.
- reference/threshold-refiner.cpp: original threshold selection and refiner dispatch.
- reference/source-manifest.json: original source paths, SHA-256 hashes and download size.
- LICENSE, NOTICE: original redistribution notices.

The C++ excerpts preserve the original functions for comparison; their MFEM dependencies were intentionally removed because the adapted JavaScript implementation uses this application's mesh structures and native TRI3 solver. Example 21 likewise cannot compile within this reduced directory. Restore a full MFEM distribution if you need to build the upstream examples.

Upstream: https://mfem.org/ and https://github.com/mfem/mfem.
