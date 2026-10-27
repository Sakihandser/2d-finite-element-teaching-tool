# Solid constitutive reference snapshots

These are unmodified source snapshots downloaded from public GitHub repositories on 2026-10-26. `manifest.json` records immutable commit URLs and SHA-256 hashes. The local `.gitattributes` preserves source bytes across Windows checkout.

- `cb-geo/`: CB-Geo MPM Authors, MIT license in `cb-geo/license.md`.
- `johnson-cook/`: Mauro Francisco Arcidiacono, MIT license in `johnson-cook/LICENSE`.

The application adapts the relevant constitutive equations and integration approaches to its own C++/Eigen material-point interface in `TensoraCore/SolidConstitutive.h`. These snapshots are attribution and audit material; they are not compiled, linked, or executed as runtime dependencies. No Abaqus or MPM framework dependency is required. See `docs/SOLID_CONSTITUTIVE.md` for the exact implemented variants and exclusions.
