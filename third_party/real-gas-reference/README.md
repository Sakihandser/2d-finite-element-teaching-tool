# Real-gas reference snapshots

Unmodified GitHub sources downloaded on 2026-10-26. `manifest.json` records immutable commit URLs and original-byte SHA-256 hashes; `.gitattributes` preserves those bytes across Windows checkout.

- `singularity/`: Triad National Security / LANL, BSD-3-Clause, license retained in that directory.
- `nasg/`: Joris Cazé, MIT, license retained in that directory.
- `cubic/`: Sho Hirose, MIT, license retained in that directory.

Relevant EOS relations were adapted into the application's `GasConstitutive.h`. These files provide source and attribution evidence; they are not runtime dependencies. The NASG calibration, saturation solvers, general cubic-EOS framework and Singularity portability layer are not imported. See `docs/GAS_CONSTITUTIVE.md` for the implemented caloric closures, unit conversion and domain restrictions.
