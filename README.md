# 2D Finite Element Teaching Tool

A portable, browser-based 2D finite element modeling and analysis application for teaching, classroom demonstrations, and exploratory learning.

The project combines an interactive HTML/Canvas interface, automatic triangular meshing, and a native C++ TRI3 solver. It is designed to run offline on a clean 64-bit Windows computer without installing Node.js, npm, Visual Studio, Eigen, or the Microsoft Visual C++ Redistributable.

> **Educational notice:** This software is intended for teaching and demonstration. It has not been certified or independently validated for safety-critical, professional, or production engineering decisions.

## Updates

See [CHANGELOG.md](CHANGELOG.md) for feature updates and validation notes.

## Highlights

- Interactive geometry construction with nodes, straight lines, quadratic curves, cubic curves, and arcs.
- Parameter-based rectangles, isosceles triangles, circles, and ellipses with live previews and centroid dragging.
- Automatic intersection nodes and closed-region detection.
- Separate geometry nodes and finite element analysis nodes.
- Free and fixed-support mechanical states for nodes and boundaries.
- Point loads, linearly varying distributed loads, and regional or global body forces.
- Material assignment with an editable project material library.
- Exterior-air regions for holes and cavities.
- Automatic analysis-node placement and constrained TRI3 meshing.
- Mesh coverage checks for constrained edges, holes, and region area.
- Native C++ finite element solution through an in-memory binary pipe.
- Optional FP64 OpenCL element computations with automatic CPU fallback; see [GPU computation scope and measured limitations](docs/GPU_COMPUTE.md).
- Deformation, stress, strain, and safety-check result views.
- GPU-first WebGL rendering for dense meshes, analysis nodes, and result clouds, with automatic Canvas 2D fallback.
- JSON model import and export.
- Chinese and English interface modes with persistent language selection.
- Fully portable Windows package available from GitHub Releases.

## Quick Start on Windows

1. Open the repository's **Releases** page and download the Windows x64 portable ZIP.
2. Extract the complete archive and keep its directory structure unchanged.
3. Double-click `RUN_PROGRAM.bat`.
4. Wait for the default browser to open the local application.
5. Keep the launcher window open while using the program. Close it to stop the local server.

Do not open `index.html` directly. Browser security restrictions would prevent reliable project-file access and automatic execution of the C++ solver.

For command-line development, run:

```powershell
.\node-v24.21.0-win-x64\node.exe .\server.js
```

The application normally opens at `http://127.0.0.1:5173/`. If that port is unavailable, the launcher reports the active local address.

## Portable Runtime

The Windows x64 portable release contains everything required for offline use on modern 64-bit Windows:

- `node-v24.21.0-win-x64/node.exe` — bundled Node.js runtime used by the local server.
- `node-v24.21.0-win-x64/LICENSE` — Node.js and bundled third-party license notices.
- `计算力学程序计算核心/x64/Release/计算力学程序计算核心.exe` — prebuilt 64-bit Release solver.
- `计算力学程序计算核心/x64/Release/vcomp140.dll` — bundled OpenMP runtime required by the solver.

The native solver statically links the normal MSVC C/C++ runtime. Eigen and other C++ header libraries are build-time source dependencies only and do not need to be installed or copied to the target computer.

Internet access is optional. Modeling, meshing, and solving work offline. The material-property web search feature requires an internet connection because it opens an external search engine.

## Typical Teaching Workflow

1. Open the **Structure** page and draw a closed geometry.
2. Mark boundaries or nodes as **Fixed Support** where required.
3. Right-click a structural region and assign a material.
4. Add point, distributed, or body loads.
5. Open the **Analysis** page.
6. Generate analysis nodes and the triangular mesh.
7. Run the C++ solver.
8. Open the **Results** page to inspect deformation, stress, strain, and safety information.

The language selector in the upper-right corner switches the complete interface between Chinese and English without reloading the page or clearing the current model.

## Geometry and Regions

The **Regular Shapes** buttons on the Structure page open a floating parameter window. Enter dimensions in meters, rotation in degrees, and centroid X/Y coordinates; the canvas preview updates immediately. Drag the centroid crosshair to position the complete shape (following Snap to Grid), then select **Create Shape** to commit its closed boundaries. Cancel or Escape discards the preview. Triangle dimensions specify the base and height of an isosceles triangle; ellipse dimensions specify full axis lengths. Circles use circular arcs and ellipses use exact rational quadratic quarter-arcs, sampled by the existing region and mesh workflows. Created boundaries and nodes remain editable with the existing tools and are included in JSON export/import.

- Geometry objects are stored separately from analysis objects.
- `geometryNodes` describe the drawing model.
- `analysisNodes` are generated for meshing and solution.
- Closed boundaries are detected as structural `regions` and labeled `R1`, `R2`, and so on.
- Intersections between boundaries generate geometry nodes automatically.
- A region can be marked as exterior air to represent a hole or cavity.
- Region records retain material identifiers, colors, and mechanical-property snapshots.

The browser API exposes helpers such as:

```javascript
window.femSketchApi.getGeometryStateAtPoint(point);
window.femSketchApi.getStructureRegionAtPoint(point);
window.femSketchApi.getMaterialAtPoint(point);
window.femSketchApi.createAnalysisNode(point);
window.femSketchApi.classifyAnalysisNodes();
window.femSketchApi.setAnalysisMesh({ analysisNodes, elements });
```

## Loads

The application supports:

- Concentrated point loads attached to geometry nodes or free positions.
- Distributed boundary loads with independent start and end intensities.
- Regional or global body forces.
- Direction input by dragging or by entering an angle.
- Interactive editing of magnitude, end magnitude, and direction.

Distributed-load intensities are interpolated linearly along the selected boundary. Their display uses one scale for the complete load, so the arrow envelope remains linear even when the numerical values are large.

## Meshing

The Analysis page supports optional ZZ adaptive refinement for the existing plane-stress TRI3 solver. Enable **Adaptive Mesh (ZZ)** and click **Start Calculation**. Adaptive mode preserves an existing valid ordinary mesh and ignores the ordinary node limit. Bulk error marking and background refinement select local density; the same Triangle WASM engine used for ordinary meshing rebuilds the connections. Locally saturated point-force cells are skipped while other regions continue refining. See [adaptive mesh implementation and limits](docs/ADAPTIVE_MESH.md).

The analysis page places nodes on geometry endpoints, boundary curves, point-load anchors, and region interiors. Node spacing is estimated automatically from geometry size, boundary length, and the configured node limit.

TRI3 elements are generated with `triangle-wasm`, based on Triangle 1.6. Each structural region is represented as a planar straight-line graph with its exterior contour, constrained edges, interior points, and nested holes.

Before a mesh is accepted, the application checks that:

- Every constrained boundary edge is used by an element.
- No element crosses a structural boundary or fills an air region.
- The total element area matches the net structural area.
- Element node references are valid and non-degenerate.

## Solver Communication

The default calculation path transfers the complete model and result through binary standard input and output:

```text
Browser UI -> Node.js local server -> binary stdin -> C++ solver
Browser UI <- Node.js local server <- binary stdout <- C++ solver
```

This avoids using text files as an intermediate calculation channel. Optional text export can still generate:

- `calculation-data/calculation-input.txt`
- `calculation-data/calculation-result.txt`

These files are useful for inspection, teaching, and interchange with external tools, but they are disabled by default.

## Result Views

Dense mesh and result layers use a shared WebGL renderer when the browser supports hardware acceleration. It requests `powerPreference: "high-performance"` and refuses major performance caveats; browser and driver policy determine the actual GPU. Unsupported WebGL, initialization failures, or context loss fall back to Canvas 2D automatically. Geometry and color buffers are cached, while pan, zoom, and deformation update GPU uniforms. A bounded cache limits retained result buffers. The existing Canvas overlay continues to draw labels, axes, loads, and controls. Mesh edge antialiasing and dashed guide appearance can differ slightly between backends.

Result loading uses indexed node/element writeback; component ranges, panel bounds, and legends are cached. Pointer-driven redraws are coalesced to animation frames, and hidden result views do not keep rendering deformation animations. The solver and numerical results are unchanged. For the WebGL preference semantics, see the [Khronos WebGL specification](https://registry.khronos.org/webgl/specs/latest/1.0/).

Open `http://127.0.0.1:5173/tests/gpu-renderer-browser.html` after launching the local server for the 32,768-triangle browser benchmark, GPU context loss/restoration check, and 20,000-element production view check. Append `?fallback=1` to test the production Canvas fallback. Benchmark timings measure JavaScript drawing submission, not asynchronous GPU completion or frame rate.

The Results page can display:

- Undeformed and deformed geometry.
- Displacement magnitude.
- Equivalent stress.
- Equivalent strain.
- Individual stress and strain components.
- Material-strength safety status.

The page first uses the structured result retained in server memory. It can also read compatible text result files when no in-memory result is available.

## Project Structure

```text
.
|-- index.html                         Main application interface
|-- app.js                             Browser application entry point
|-- server.js                          Local Node.js server and solver bridge
|-- calculation-ipc.js                 Binary Node.js/C++ protocol
|-- RUN_PROGRAM.bat                    Recommended Windows launcher
|-- start.bat                          Developer launcher
|-- node-v24.21.0-win-x64/             Bundled in the Windows portable release
|-- src/
|   |-- global/                        Shared state and localization
|   |-- core/                          Geometry, mesh, material, and export logic
|   |-- pages/                         Structure, analysis, results, and materials UI
|   |-- styles/                        Split application styles
|   `-- vendor/triangle-wasm/          Triangle WebAssembly integration
|-- materials/                         Editable material library
|-- calculation-data/                  Optional calculation exchange files
|-- tests/                             Regression and integration tests
|-- docs/                              Architecture and format documentation
`-- 计算力学程序计算核心/              C++ finite element solver project
```

Additional implementation notes are available in `docs/PROJECT_STRUCTURE.md` and `docs/CALCULATION_EXPORT_FORMAT.md`.

## Running the Tests

No npm installation is required when using the Windows portable release. Run all regression tests with its bundled Node.js executable:

```powershell
.\node-v24.21.0-win-x64\node.exe --test `
  .\tests\analysis-mesh.test.js `
  .\tests\calculation-ipc.test.js `
  .\tests\distributed-load-display.test.js `
  .\tests\regular-shapes.test.js `
  .\tests\gpu-renderer.test.js `
  .\tests\result-performance.test.js `
  .\tests\i18n.test.js
```

The tests cover concave domains, holes, shared material boundaries, dense meshes, binary Node.js/C++ communication, full-model numerical regression, distributed-load visualization, and interface localization.

## Development Notes

- `app.js` contains startup wiring and the public browser API.
- `src/global/state.js` contains shared DOM references and application state.
- `src/global/i18n.js` handles Chinese/English localization, including dynamic text, dialogs, and Canvas labels.
- `src/core/scene-objects.js` defines geometry and load objects.
- `src/core/regions.js` handles closed regions, air regions, and material assignment.
- `src/core/analysis-node-placement.js` generates analysis nodes.
- `src/core/analysis-mesh.js` generates and validates TRI3 meshes.
- `src/core/calculation-export.js` builds solver-ready model data.
- `src/pages/drawing/` contains the main modeling viewport and interactions.
- `src/pages/calculation/` contains the analysis viewport and controls.
- `src/pages/results/` contains result parsing and visualization.
- `src/pages/materials/library.js` manages the project material library.

Page-specific logic should remain under `src/pages/<page>/`. Reusable geometry, analysis, or data logic should be placed under `src/core/`.

## License

The original source code of this project is released under the [MIT License](LICENSE).

### Third-Party Components

This project uses the following third-party components, which remain under their respective licenses:

- **Triangle 1.6** (via triangle-wasm): Used for automatic triangular meshing.
  Free for private, research, and institutional use.
  **Commercial distribution requires permission from Jonathan Richard Shewchuk.**
  See `src/vendor/triangle-wasm/THIRD_PARTY_NOTICES.txt` and the official page:
  https://www.cs.cmu.edu/~quake/triangle.html

- **Node.js**: Bundled runtime, see `node-v24.21.0-win-x64/LICENSE`.
- **triangle-wasm** JavaScript wrapper: MIT License.
- **OpenMP runtime**: Included with the portable solver package.

**Summary**: The software is free for educational, research, and private use. Commercial use or distribution of the complete package is restricted by Triangle’s license.

## Intended Use

This project is primarily intended for:

- Introductory finite element method courses.
- Computational mechanics demonstrations.
- Classroom exercises involving boundary conditions and loads.
- Visualization of meshing and TRI3 element behavior.
- Experimentation with a browser-to-native numerical workflow.

For engineering practice, verify all formulations, units, material data, boundary conditions, mesh convergence, and solver results with independently validated software and applicable standards.
