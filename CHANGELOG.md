# 更新日志 / Changelog

## 2026-10-27 — High-resolution application icon

- 重新生成 TENSORA 高清图标，ICO 内含 16–256 像素的十种尺寸；窗口与 EXE 使用同一图标，构建保留高清资源，README 展示品牌图标。 / Regenerate the TENSORA logo and ship ten ICO resolutions for window and executable icons.

## 2026-10-27 — TENSORA branding

- 正式名称统一为 TENSORA；更新窗口标题、应用图标、Windows 启动器文件名和元数据，以及仓库与分支功能介绍。 / Adopt TENSORA as the product name across the application, launcher and project documentation.

## 2026-10-27 — English solver paths

- 计算核心目录、Visual Studio 解决方案/工程及可执行文件统一为 `TensoraCore`；同步服务端、原生验证工程、测试、基准脚本及文档引用，并重新编译 x64 Release 核心。 / Rename the native solver to TensoraCore and update all consumers and build references.

## 2026-10-27 — Export to a chosen save location

- 模型 JSON、计算结果 ZIP、PNG 云图和爆破结果导出统一先打开“另存为”，直接写入用户选择的文件；取消时不生成结果，写入失败时放弃未完成的内容。结果 ZIP 与爆破报告采用流式写入。 / Choose a save location before exporting models and results, with streamed ZIP writes and cancellation handling.

## 2026-10-27 — Remove blast samples and repository leftovers

- 移除爆破圆孔及气体耦合示例载入按钮、载入逻辑、示例模型和对应翻译；空白模型提示和使用文档改为创建或导入用户模型。 / Remove bundled blast samples and their UI; use user-created or imported models.
- 回归测试改用按需生成的最小几何，不再依赖应用示例文件。删除未采用的 Laghos 调研源码和重复 BAT 启动入口；保留运行依赖、维护工具和实际算法来源，本地构建缓存及日志由 Git 忽略。 / Generate test geometry and remove unused references and the duplicate launcher; keep local build outputs and logs out of source commits.

## 2026-10-26 — Console-free Windows application launcher

- 新增 `计算力学程序.exe`：优先系统默认的 Chrome/Edge，独立应用窗口，后台启动 Node 服务，无服务器控制台。 / Add a console-free browser application launcher.
- 每目录单实例、重复启动激活、端口就绪检测与记忆、独立浏览器配置；关闭最后窗口时结束服务，Windows Job 保障异常退出及计算子进程清理。保留 BAT 调试入口。 / Own the service/browser/solver lifetime and keep existing debug launchers.
- 增加 Windows 真实进程树测试和隔离的服务生命周期测试；构建脚本验证通过后才输出 EXE。启动说明见 `docs/WINDOWS_LAUNCHER.md`。 / Add native lifecycle and server integration tests.

## 2026-10-26 — Live constitutive restrictions and real-gas EOS

- 本构、平面假设、运动学、初始加载、气体 EOS 与端部条件冲突时立即弹窗，并持续显示原因、禁用运行；逐材料覆盖与草稿一并检查，修正后解除。 / Show immediate incompatibility dialogs and persistent actionable feedback, and block Run until corrected.
- 新增 Noble–Abel、Stiffened Gas、NASG、受限单相 van der Waals；产物/间隙分别选择，接入压力、声速、初始能量反算、CFL、界面与守恒孔壁功。 / Add four gas EOS to both products and gap gas.
- 扩展炸药/气体库的参数保存与旧数据兼容，保留实际 GitHub 下载的源码、许可与校验和。当前新 EOS 要求轴向封堵。模型范围和 317 项回归结果见 `docs/GAS_CONSTITUTIVE.md`。 / Preserve licensed upstream snapshots and validate the new EOS and UI restrictions.

## 2026-10-26 — Solid constitutive library for blast dynamics

- 增加 11 个可逐材料选择的固体本构：J2、JC、MC、Maxwell/Prony、Neo-Hookean、MCC 常弹性变体、椭圆 DP-Cap、Perzyna、正交各向异性、Mooney–Rivlin、HJC 连续压实变体；保留原有模型和 JSON ID。 / Add eleven per-material solid models while preserving existing IDs.
- 接入参数编辑、SI 换算、保存/导入、三维材料状态、初始屈服检查、有限变形超弹性和材料刚度稳定步长；新增温度、硬化压力及压实状态帧/CSV 字段。修复模型选择触发预览重绘时丢失本构草稿的问题。 / Integrate material cards, constitutive updates, stability and export; retain drafts across preview redraws.
- 保留实际下载的 MIT 参考源码、许可和 SHA-256；加入解析、材料点及原生爆破回归。方程与具体变体见 `docs/SOLID_CONSTITUTIVE.md`。流体求解器未改。 / Preserve licensed reference sources and add numerical verification; fluid solvers are unchanged.

## v1.2.0 — 2026-10-24

- 新增独立爆破工作区、瞬态动力学、气体/岩石耦合、材料本构、爆炸物/气体库及损伤显示。 / Add an optional blast workspace, transient dynamics, gas/rock coupling, constitutive models, explosive/gas libraries and damage visualization.
- 新增完整结果表格/SVG/PNG 导出，改进大历史流式读取、播放、损伤显示和自适应网格。 / Add result table/SVG/PNG exports and improve streamed histories, playback, damage display and adaptive meshing.
- 提供 SI 单位输入、双语校验与适用边界文档；数值验证不等于材料标定。 / Include SI inputs, bilingual validation and scope documentation; numerical verification is not material calibration.

## 2026-10-22 — Stable bilingual blast messages and language switching

- Fixed a MutationObserver feedback loop: restoring untranslated source text/attributes wrote the same value repeatedly. Translation now avoids identical writes and suspends observation during its own DOM changes. Language changes redraw only the active page.
- Keep complete canonical source messages for cavity, damage, library and run status. Translate complete parameterized damage/energy errors, completion counts and gas diagnostics, and map native/server errors to Chinese source messages for consistent bilingual display.
- Preserve source labels and EOS options when building a library editor in English, so switching back restores Chinese without resetting the draft. Localized the blast-library captions and gas badge; user model names and numeric inputs are retained.

## 2026-10-22 — Runnable tensile-damage demonstrations and material preflight

- Added per-material tensile-strength inputs to Blast Setup. Valid changes persist to the material library and region snapshots without invalidating the mesh; blank/invalid strengths focus the affected input.
- Added shared browser/server preflight for positive strengths and the native crack-band Gf > h*ft²/(2E) requirement, reporting the material, critical element and fracture-energy lower bound while retaining native validation.

## 2026-10-22 — Optional blast library and detailed model zoom

- Made Blast Library follow the Blast specialty toggle. Disabling it hides the tab, prevents direct navigation and exits the active library page while preserving its draft.
- Expanded drawing, calculation and result camera scales to 0.0001–10,000,000 pixels per metre, retaining cursor-centred zoom and imported/restored camera scales. Fit now uses actual model bounds instead of a minimum one-metre size and fixed low scale ceiling.

## 2026-10-22 — Standalone blast library

- Added a Blast Library tab alongside Materials, with independent TNT/explosive and gas editors, new/save/copy/delete/reload actions and explicit application to Blast Setup. Library editing and saving preserve the current model settings. Setup keeps compact record selectors and links to the corresponding library category.
- Passed 17 focused checks including editor isolation, persistence, independent page access and bilingual labels; browser-verified draft isolation, application and gas-category navigation.

## 2026-10-22 — Model-first blast setup

- Put calculation method and borehole geometry first. The explosive and gas selectors and their parameters appear together below only for gas-dynamics calculations; prescribed-pressure mode shows its pressure and pulse controls. Mode changes preserve entered values.
- Collapsed library metadata, notes, save/delete operations and gas-model explanations. Moved radial gas resolution into the time-integration controls, visible only in gas mode, and placed confinement and boundary settings side by side.
- Passed 16 focused library, visibility, workspace and localization checks; verified both source modes, retained inputs, EOS-dependent fields and expandable library controls in the browser.

## 2026-10-21 — Reusable explosive/gas libraries and exported heterogeneous plate models

- Added independent persistent explosive and gas libraries, with selection, editing from the existing solver fields, save, save-as, delete and revision conflict detection. Records use SI units; switching one library preserves the other source and all geometry/integration settings. Included the user's PETN, TNT and ideal-air data with documented E0/density conversions.

## 2026-10-21 — Long-duration and refined blast gas calculations

- Fixed the compressed-air annulus bottleneck with conservative rezoning inside each material and adaptive allocation of the existing radial cells. Material interfaces, per-material mass, radial momentum and total gas energy are preserved through the remap.
- Reused gas step buffers and thermodynamic evaluations, and evaluated instantaneous wall pressure from the outer cell instead of reducing the entire gas state on every rock step.
- Removed the fixed two-million cumulative gas-step rejection. The configured wall-clock timeout and physical-state/timestep-collapse checks remain active.

## 2026-10-21 — Material-driven gas/rock coupling and selectable product EOS

- Added a native conservative radial HLLC gas solver coupled to the existing 2D rock mesh through mean cavity volume and wall pressure. Air gaps produce wave arrival and reflection; the gas mode ignores the manual pulse peak and duration.
- Users choose common density/detonation-speed/heat-release parameters (strong-CJ ideal-products approximation), calibrated JWL coefficients, or custom ideal-product gamma. The gas card shows the relevant fields and preserves inactive settings. Demonstration values are explicitly uncalibrated.
- Adapted Clawpack Riemann contact-state formulas and LANL Singularity-EOS JWL pressure/energy/bulk modulus; retained pinned sources, hashes and BSD notices in third_party. Laghos remains a downloaded research reference.
- Extended streamed frames with gas internal/kinetic energy, wall work and radius while preserving the legacy frame layout. Pressure charts use computed samples; gas energy diagnostics and a verification example are available in the dedicated blast workspace.
- All 149 regressions pass, including Sod exact-solution convergence, contact equilibrium, moving-wall energy conservation, JWL thermodynamic derivative, gas/rock wall work, model choice, no-gap charge, pressure independence from manual pulses and extended HTTP/export round trips. Rebuilt the portable x64 Release core. Browser validation completed a 952-node / 1752-element air-gap run and model switching without console errors.
- Scope is initially reacted products and concentric radial gas dynamics. Finite-rate chemistry, afterburn, angular/axial flow and crack venting are not implemented; numerical verification is not material calibration. See docs/GAS_COUPLING.md.

## 2026-10-21 — Independent charge/cavity radii and shared-mesh reuse

- Split charge radius from actual cavity radius. A smaller concentric charge can leave an air gap; blast pressure is applied to the wall identified from the solid mesh. Cavity detection preserves charge size, and legacy settings remain compatible.
- Added explicit wall detection, wall/charge size validation, radial-gap readouts and an air-annulus visualization. Multiple holes require selection.
- The pressure input explicitly prescribes wall pressure. Air propagation, attenuation and gas-rock coupling are not solved by this change.
- Clarified that both ordinary and adaptive meshes from the basic workspace are shared and reusable for blast analysis. The blast mesh button explicitly regenerates an ordinary mesh.
- Added 11 regressions for independent charge geometry, native confinement loading, detection, adaptive mesh solving, legacy compatibility and shared-mesh preservation. Static ZZ refinement is reusable but does not certify transient-wave resolution.
- All 135 tests pass. Browser validation used a 0.05 m charge in a 0.1 m cavity with the 952-node / 1752-element mesh generated on the basic calculation page.

## 2026-10-21 — Optional professional workspaces

- Added a top-right Specialties selector. First launch exposes the four basic static-analysis pages; opting into Blast Simulation reveals dedicated Blast Setup and Blast Results tabs. The browser remembers the selection.
- Moved blast inputs into grouped cards with model preview, shared geometry/material links, mesh preparation and individual boundary overrides. Removed blast settings from the static calculation sidebar.
- Isolated static and blast result data, plots, cameras and deformation scales. Disabling the specialty hides its tools, stops playback and cancels pending blast work while retaining completed history and parameters for the session.
- Added preference, workspace-isolation and asynchronous result-switch regressions, with bilingual interface coverage. Updated the blast workflow documentation.
- Verified all 124 regressions, plus browser checks for opt-in, persistence, model/mesh preparation, a 952-node blast run, separate result tools, disabling/re-enabling and language switching. Fixed canvas overflow into the inspector at narrower window sizes.

## 2026-10-21 — Large blast histories, absorbing boundaries and in-situ loads

- Replaced whole-history JSON with binary streaming, compressed files per frame, bounded browser frame caching and explicit release of prior GPU buffers. Removed the 2-million-value and 200-million-element-update rejections; added configurable runtime and native cancellation.
- Added global and per-curve existing/free/fixed/viscous-absorbing conditions. Cavity pressure boundaries remain active; quiet boundaries use normal/tangential impedance with coupled 2×2 nodal damping.
- Added external-load elastic equilibration or sudden loading, persistent point/distributed/body loads, horizontal/vertical outer confinement and optional plane strain. Prestress-equilibrium residuals are checked; initial damage requiring nonlinear equilibration is explicitly rejected.
- TNT contours show stress perturbations relative to the initial equilibrium; ordinary stress plots show total stress. Full histories export as streamed JSON gzip files.
- Passed all 118 tests. Verified 15,552 nodes / 30,720 cells / 61 frames with 10 MPa biaxial confinement and quiet boundaries (about 5 seconds on the development machine), plus a 31,058-cell browser run. Includes reflection, prestress, load-transfer, cache, GPU release, export and cancellation regressions. See [workflow and limits](docs/BLAST_DYNAMICS.md).

## 2026-10-21 — TNT source visualization

- Added a TNT source illustration in model and blast result views, synchronized pressure highlighting, and a pressure-history card with current-time marker.
- Added a dedicated TNT view with a fixed history-wide stress color scale, computed stress-response boundaries and highly damaged cell outlines. Display layers do not change blast solver inputs.
- Added bilingual controls and checks for source state, shared-edge response boundaries, fixed scale and zero-response histories. TNT is an illustration; pressure remains prescribed by the existing pulse model.

## 2026-10-21 — Transient cavity blast and tensile damage

- Adapted MFEM dynamics/operator and Newmark references into the native TRI3 core: lumped mass, central difference, automatic stable time step, closed cavity half-sine pressure and optional mass damping.
- Added irreversible tensile damage with element-size/energy-based exponential softening, per-frame stress/strain/displacement, damage contours, playback and JSON history export.
- Added a circular-cavity demo and bilingual controls. Rebuilt the portable x64 Release solver; preserved the static binary protocol.
- Passed all 104 tests, including 8 new blast checks for wave delay, momentum, energy, second-order time convergence, irreversible damage, fixed supports, damping and invalid inputs. Verified the 952-node/1752-element demo in the browser.
- Scope: 2D plane stress, small deformation and continuous damage bands. No discrete crack opening, fragment contact, crushing, explosive reaction or absorbing boundary. See [model and validation limits](docs/BLAST_DYNAMICS.md).

## 2026-10-20 — Sidebar scrolling and manual result deformation scale

- Made both sidebars scroll independently with the mouse wheel on drawing, calculation, and result pages. Groups retain their natural height, and selection details no longer push lower controls outside the viewport.
- Added clickable, keyboard-accessible collapse buttons to sidebar group headings.
- Removed automatic deformation-scale animation. Results load at 1×, and a slider lets users choose between 1× and the suggested scale, showing both the current and suggested values. Switching result plots retains the manually selected scale.

## 2026-10-20 — Drawing undo, division points, and construction geometry

- Added Undo / Ctrl+Z for up to 100 drawing steps, including continuous drags, deletion, geometry conversion, regular shapes, clearing, and JSON import.
- Added 2–5 equal division points for selected straight segments, reusing existing nodes and retaining the original segment.
- Added dashed construction geometry for all curve and regular-shape tools, automatic intersections with real or construction curves, and independent node/curve conversion in the inspector.
- Excluded construction geometry from region partitioning, analysis boundaries, fixed-support classification, and calculation loads; retained construction flags in JSON.
- Added regression tests for editing history, all curve types, region isolation, solver exclusions, import, and load restoration, plus Chinese/English interface labels.

## 2026-10-15 — Configurable adaptive time limit

- Added a maximum time per round in seconds, editable after enabling adaptive meshing; the default remains 10 seconds.
- Automatic adaptation, Refine Once, native solver timeouts, and refinement worker timeouts use the selected limit and keep the last successful result on timeout.
- Added validation and regression coverage for custom durations, timeout propagation, and control availability.

## 2026-10-13 — Adaptive time protection

- Stop adaptive refinement once a round reaches 10 seconds, keeping the last successful mesh and result.
- Terminate adaptive native solves after 10 seconds and restore the previous solved mesh on timeout; ordinary solves keep their existing 120-second limit.
- Run refinement in a dedicated Web Worker with a 10-second timeout so runaway Triangle refinement can be cancelled without blocking the UI.

## 2026-10-13 — Adaptive boundary material fix

- Preserved constrained Triangle region attributes during element classification so refinement near curved holes and material interfaces cannot overwrite solid elements with air or another material.
- Added adaptive material/area validation before native solves and element-specific diagnostics for invalid ZZ inputs.

## 2026-10-13 — Adaptive controls

- Changed the default adaptive refinement limit to 6 steps.
- Enabling adaptive mode clears the existing analysis mesh and places fresh seed nodes; automatic adaptive calculations rebuild from a fresh seed.
- Added Refine Once to refine the current mesh by one step and solve the resulting mesh, with existing failure recovery and size protections.

## 2026-10-13 — Calculation settings

- Added a default-off GPU acceleration checkbox. Enabling it shows a recommendation to wait until more than two million elements; each request selects CPU/GPU explicitly, with CPU fallback and a consistent choice across adaptive rounds.
- Increased the ordinary default analysis-node limit to 20,000, adaptive refinement steps to 10, and tightened the default relative-error target to 0.02 (2%).

## 2026-10-13 — GPU compute crossover measurements

- Swept 2,048–991,232 elements with five paired CPU/GPU solves at each size, checked a retained GPU context, and benchmarked nine real ZZ/Triangle adaptive mesh snapshots. No GPU crossover was found on i9-13900HX + RTX 4070 Laptop GPU with the current element-only OpenCL backend.
- Removed the unmeasured 131,072-element automatic switch. Default auto mode retains CPU when no validated crossover exists; `FEM_GPU_MIN_ELEMENTS` supports a measured threshold on other hardware, while forced GPU mode and CPU fallback remain available.

## 2026-10-13 — Adaptive mesh refinement

- Replaced the point-force patch's coarse central cutoff with a continuous size field and explicit center refinement. The center is finer than its surrounding ring while background refinement continues. Triangle memory now grows beyond its former fixed 16 MB limit, with refreshed IO views; validated during a 320,000-triangle mesh operation.
- Combined adaptive density selection with the existing Triangle WASM refinement engine. Preserves a valid ordinary mesh, replaces maximum-error-only marking with bulk/background selection, and skips locally saturated point-force patches while refining other regions. An eight-round native C++ point-force regression completes without premature small-element failure.
- Improved adaptive triangle connections with constrained local diagonal flips after every refinement and before the initial solve. Added a native C++ elliptical-slit regression: minimum angle improves from 2.27° with the preceding fixed connections to 12.59°, while the tip stress concentration and closed hole are preserved.
- Adaptive mode now ignores the ordinary node limit, uses an independent coarse initial mesh, disables the node-limit input, and migrates meshes from the former capped workflow. Refinement stops according to error and iteration count.
- Added optional ZZ stress-recovery refinement adapted from MFEM 4.10 Example 21 for the existing plane-stress TRI3 solver.
- Added conforming shared-edge local refinement, material interface separation, boundary/load provenance, bounded iteration history, and restoration of the last solved mesh on failure.
- Retained relevant MFEM reference code and license notices; removed the unused downloaded library files.
- Verified local mesh topology, load preservation, estimator integration and native C++ adaptive cantilever solves.

## v1.1.0 — 2026-10-13 — 参数化几何绘制与 GPU 渲染优化

### 新增

- 绘图页面新增规则图形入口，支持矩形、等腰三角形、圆形和椭圆形。
- 参数窗口支持精确输入尺寸、旋转角度及质心坐标，修改参数时实时预览。
- 拖动预览图形的质心即可放置，支持现有吸附设置；确认创建后转为可继续编辑的边界，取消或按 Escape 可放弃预览。
- 圆与椭圆使用精确的有理二次曲线边界，支持场景保存、导入和后续网格划分。
- 新界面提供中文和英文文案。

### 性能优化

- 绘图、计算和结果页面的网格、分析节点、变形图及结果云图优先使用 WebGL，向浏览器请求高性能 GPU。
- 缓存 GPU 顶点及颜色缓冲区，平移、缩放和调整变形倍率时复用数据。
- WebGL 不可用、初始化失败或上下文丢失时自动回退到 Canvas 2D；上下文恢复后可重新启用 GPU。
- 优化结果写回、范围及视图边界缓存，合并鼠标和滚轮触发的重绘，停止隐藏页面的动画。
- 保留原有数值求解过程；实际使用的 GPU 由浏览器、驱动和系统设置决定。

### 验证

- 27 项自动化测试通过，涵盖网格、计算通信、载荷显示、语言切换、规则图形、GPU 渲染和结果性能。
- 使用 20,000 个三角形验证主要页面及结果模式的 WebGL 渲染和 Canvas 2D 回退。
- 增加 32,768 个三角形的浏览器基准页面，支持上下文丢失及恢复验证。该页面测量 JavaScript 绘制提交耗时，不代表完整 GPU 帧耗时或整机帧率。

v1.1.0 Windows 便携 ZIP 包含这些新增功能及运行依赖，解压后双击 `RUN_PROGRAM.bat` 启动。已有 v1.0.0 ZIP 保留为历史版本。

### English summary

- Add parameter-based rectangles, isosceles triangles, circles and ellipses with precise dimensions, rotation, centroid coordinates, live previews and centroid dragging.
- Use exact rational quadratic boundaries for circles and ellipses, integrated with scene import/export and meshing.
- Prefer WebGL for meshes, analysis nodes, deformation and result clouds; cache GPU buffers and automatically fall back to Canvas 2D when needed.
- Reduce CPU work in result mapping, view bounds and redraw scheduling without changing the numerical solver.
- Pass 27 automated tests and verify rendering with 20,000 triangles. Add a browser benchmark and context-loss recovery checks.
- The v1.1.0 Windows portable ZIP includes these updates and runtime dependencies. Extract it and run `RUN_PROGRAM.bat`.
