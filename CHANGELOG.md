# 更新日志 / Changelog

## 2026-10-13 — 参数化几何绘制与 GPU 渲染优化

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

本次更新为源码更新；已有 v1.0.0 Windows 便携 ZIP 不包含这些新增功能。

### English summary

- Add parameter-based rectangles, isosceles triangles, circles and ellipses with precise dimensions, rotation, centroid coordinates, live previews and centroid dragging.
- Use exact rational quadratic boundaries for circles and ellipses, integrated with scene import/export and meshing.
- Prefer WebGL for meshes, analysis nodes, deformation and result clouds; cache GPU buffers and automatically fall back to Canvas 2D when needed.
- Reduce CPU work in result mapping, view bounds and redraw scheduling without changing the numerical solver.
- Pass 27 automated tests and verify rendering with 20,000 triangles. Add a browser benchmark and context-loss recovery checks.
- This source update is not included in the existing v1.0.0 portable ZIP.
