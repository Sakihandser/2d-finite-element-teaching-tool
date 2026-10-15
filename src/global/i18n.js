/*
  界面本地化。
  中文是源语言；英文模式会翻译静态 DOM、后续动态文字、浏览器弹窗和 Canvas 标签。
  语言切换不刷新页面，避免丢失尚未保存的模型。
*/
(function initializeInterfaceLocalization() {
  "use strict";

  const LANGUAGE_STORAGE_KEY = "fem-interface-language";
  const SUPPORTED_LANGUAGES = new Set(["zh-CN", "en"]);
  const HAN_TEXT = /[\u3400-\u9fff]/u;
  const TRANSLATABLE_ATTRIBUTES = ["title", "aria-label", "placeholder"];

  const ENGLISH_TEXT = Object.freeze({
    "计算设置": "Calculation Settings",
    "使用 GPU 加速": "Use GPU acceleration",
    "建议单元数量超过 200 万个时再开启 GPU 加速。开启后不保证提速，无可用 GPU 时自动使用 CPU。": "Consider enabling GPU acceleration when the element count exceeds 2 million. It may not improve speed; if no compatible GPU is available, CPU computation is used automatically.",
    "0.02 表示 2%。自适应模式忽略节点上限，达到目标误差或细化轮数时停止。": "0.02 means 2%. Adaptive mode ignores the node limit and stops at the target error or refinement step limit.",
    "自适应网格（ZZ）": "Adaptive Mesh (ZZ)",
    "自适应网格建议用于裂纹与应力集中研究。若非专门研究此类问题，不建议使用，建议优先采用均匀网格。": "Adaptive meshing is recommended for studying cracks and stress concentrations. Unless you are specifically studying these problems, it is not recommended; prefer a uniform mesh.",
    "单轮耗时达到 10 秒时停止继续加密，保留最后成功结果，可尝试均匀网格。": "Further refinement stops when a round reaches 10 seconds. The last successful result is kept; consider a uniform mesh.",
    "自适应加密超过 10 秒，已停止。": "Adaptive refinement exceeded 10 seconds and was stopped.",
    "自适应后台加密失败。": "Adaptive refinement worker failed.",
    "自适应首轮求解超过 10 秒，已停止；请减小基础网格规模或使用普通网格计算。": "The initial adaptive solve exceeded 10 seconds and was stopped. Reduce the initial mesh size or use ordinary mesh calculation.",
    "达到 10 秒耗时保护，已保留最后成功结果；可尝试均匀网格": "10-second time protection reached; the last successful result was kept. Consider a uniform mesh",
    "迭代加密一次": "Refine Once",
    "在当前网格上迭代加密一次": "Refine the current mesh once",
    "请先生成有效网格，再进行迭代加密。": "Generate a valid mesh before refining it.",
    "达到目标误差": "Target error reached",
    "达到细化轮数上限": "Refinement step limit reached",
    "达到节点上限": "Node limit reached",
    "无可细化单元": "No elements marked",
    "局部已达到最小尺寸": "Local minimum mesh size reached",
    "Triangle 自适应输出不完整。": "Incomplete Triangle adaptive output.",
    "Triangle 改变了原有节点顺序。": "Triangle changed the existing node ordering.",
    "Triangle 丢失了约束边标记。": "Triangle lost a constrained edge marker.",
    "Triangle 丢失了区域或材料标记。": "Triangle lost a region or material marker.",
    "Triangle 自适应输出含退化单元。": "Triangle adaptive output contains a degenerate element.",
    "Triangle 自适应网格面积校验失败。": "Triangle adaptive mesh area verification failed.",
    "ZZ 误差估计需要完整、有效的单元应力和材料参数。": "ZZ estimation requires complete, valid element stresses and material parameters.",
    "ZZ 误差估计发生数值溢出。": "Numerical overflow in ZZ estimation.",
    "自适应网格存在无效节点引用。": "Invalid node reference in the adaptive mesh.",
    "自适应细化产生过小单元，已停止细化。": "Refinement stopped because an element is too small.",
    "模型在自适应计算期间发生变化，请重新计算。": "The model changed during adaptive calculation. Run the calculation again.",
    "自适应求解失败。": "Adaptive calculation failed.",
    "自适应参数无效：细化轮数 0–20，目标相对误差 0–1。": "Invalid adaptive settings: 0–20 refinement steps and relative error between 0 and 1.",
    "细化轮数": "Refinement steps",
    "目标相对误差": "Target relative error",
    "单轮最长耗时（秒）": "Maximum time per round (s)",
    "单轮耗时达到设置上限时停止继续加密，保留最后成功结果；默认 10 秒，可尝试均匀网格。": "Further refinement stops at the time limit per round and keeps the last successful result. Default: 10 seconds; consider a uniform mesh.",
    "自适应单轮最长耗时必须为 0.1–2147483 秒。": "The adaptive time limit per round must be between 0.1 and 2147483 seconds.",
    "0.05 表示 5%。自适应模式忽略节点上限，达到目标误差或细化轮数时停止。": "0.05 means 5%. Adaptive mode ignores the node limit and stops at the target error or refinement step limit.",
    "二维有限元绘图界面": "2D Finite Element Modeling",
    "功能标签栏": "Application tabs",
    "主页面": "Main pages",
    "结构绘制": "Structure",
    "计算": "Analysis",
    "计算结果": "Results",
    "材料库": "Materials",
    "界面语言": "Language",
    "中文": "Chinese",
    "绘图工具": "Drawing tools",
    "二维 FEM": "2D FEM",
    "几何": "Geometry",
    "选择 / 拖动": "Select / Drag",
    "选择": "Select",
    "几何节点": "Geometry Nodes",
    "计算节点": "Analysis Nodes",
    "直线": "Line",
    "二次曲线": "Quadratic Curve",
    "三次曲线": "Cubic Curve",
    "圆弧": "Arc",
    "规则图形": "Regular Shapes",
    "矩形": "Rectangle",
    "三角形": "Triangle",
    "三角形（等腰）": "Triangle (isosceles)",
    "圆形": "Circle",
    "椭圆形": "Ellipse",
    "规则图形参数": "Shape Parameters",
    "图形类型": "Shape type",
    "宽度 / 横轴全长 (m)": "Width / full X-axis (m)",
    "高度 / 纵轴全长 (m)": "Height / full Y-axis (m)",
    "底边 (m)": "Base (m)",
    "高度 (m)": "Height (m)",
    "半径 (m)": "Radius (m)",
    "旋转角 (°)": "Rotation (°)",
    "质心 X (m)": "Centroid X (m)",
    "质心 Y (m)": "Centroid Y (m)",
    "修改参数实时预览，拖动画布中的质心定位。创建后可继续编辑边界。": "Preview updates as you type. Drag the centroid on the canvas to position the shape. Boundaries remain editable after creation.",
    "旋转角以 x 正轴为基准，逆时针为正。拖动遵循“吸附网格”设置。": "Rotation is counterclockwise from the positive x-axis. Dragging follows the Snap to Grid setting.",
    "拖动质心放置": "Drag centroid to position",
    "创建图形": "Create Shape",
    "取消": "Cancel",
    "请输入有效的几何参数。": "Enter valid geometry parameters.",
    "尺寸必须大于或等于 0.000001 m。": "Dimensions must be at least 0.000001 m.",
    "橡皮擦": "Eraser",
    "载荷": "Loads",
    "点载荷": "Point Load",
    "分布力": "Distributed Load",
    "体力": "Body Force",
    "q起": "q start",
    "q止": "q end",
    "体力范围": "Body-force Scope",
    "体力作用范围": "Body-force scope",
    "点击区域": "Pick Region",
    "全局": "Global",
    "方向": "Direction",
    "载荷方向输入方式": "Load direction input",
    "拖拽": "Drag",
    "角度": "Angle",
    "视图": "View",
    "适应窗口": "Fit View",
    "动画预览": "Animation Preview",
    "吸附网格": "Snap to Grid",
    "文件": "File",
    "保存 JSON": "Save JSON",
    "导入 JSON": "Open JSON",
    "清空": "Clear",
    "模型": "Model",
    "未命名模型": "Unnamed Model",
    "二维有限元绘图视窗": "2D finite element drawing viewport",
    "填充材料": "Assign Material",
    "未选择区域": "No region selected",
    "模型信息": "Model information",
    "对象": "Objects",
    "边界": "Boundaries",
    "结构区域": "Structural Regions",
    "单元": "Elements",
    "无": "None",
    "几何属性": "Geometry Properties",
    "未选择几何对象": "No geometry selected",
    "状态": "Status",
    "几何对象状态": "Geometry object state",
    "可变形结构": "Deformable structure",
    "自由结构": "Free Structure",
    "静态支撑": "Fixed Support",
    "地面支撑": "Fixed support",
    "载荷编辑": "Load Editor",
    "未选择载荷": "No load selected",
    "大小": "Magnitude",
    "终点": "End",
    "图层": "Layers",
    "网格": "Mesh",
    "计算工具": "Analysis tools",
    "计算准备": "Analysis Setup",
    "布置计算节点": "Place Analysis Nodes",
    "自动划分网格": "Generate Mesh",
    "开始计算": "Run Analysis",
    "导出 C++ 计算输入文件": "Export C++ calculation input",
    "导出计算文件": "Export Calculation File",
    "网格设置": "Mesh Settings",
    "上限": "Limit",
    "节点": "Nodes",
    "输出设置": "Output",
    "计算始终通过内存二进制管道传输；勾选后额外生成 calculation-input.txt 和 calculation-result.txt":
      "Calculations always use the in-memory binary pipe; enable this to also generate calculation-input.txt and calculation-result.txt",
    "额外生成计算 TXT": "Also Generate Calculation TXT",
    "二维有限元计算视窗": "2D finite element analysis viewport",
    "计算信息": "Analysis information",
    "计算对象": "Analysis Objects",
    "约束节点": "Constrained Nodes",
    "几何同步": "Geometry Sync",
    "网格划分": "Meshing",
    "变形计算": "Deformation",
    "就绪": "Ready",
    "待生成": "Not Generated",
    "待结果": "Awaiting Results",
    "结构": "Structure",
    "变形": "Deformation",
    "计算结果工具": "Result tools",
    "结果图": "Result Plot",
    "显示变形图": "Show deformation",
    "变形图": "Deformation",
    "显示应力云图": "Show stress contours",
    "应力云图": "Stress Contours",
    "显示应变云图": "Show strain contours",
    "应变云图": "Strain Contours",
    "显示安全校核图": "Show safety check",
    "安全校核图": "Safety Check",
    "显示": "Display",
    "重新读取结果": "Reload Results",
    "倍": "×",
    "未读取结果": "No Results Loaded",
    "二维有限元计算结果视窗": "2D finite element results viewport",
    "滚轮缩放，拖动平移；点击适应窗口恢复完整视图。": "Scroll to zoom, drag to pan; click Fit to restore the full view.",
    "计算结果信息": "Result information",
    "结果摘要": "Summary",
    "最大位移": "Max Displacement",
    "不安全单元": "Unsafe Elements",
    "数值范围": "Value Ranges",
    "最大等效应力": "Max Equivalent Stress",
    "最大等效应变": "Max Equivalent Strain",
    "生成时间": "Generated",
    "图例": "Legend",
    "等待读取 calculation-data 中的结果文件。": "Waiting for results from calculation-data.",
    "本地材料": "Local materials",
    "材料编辑": "Material editor",
    "Q235钢": "Q235 Steel",
    "ASTM A36结构钢": "ASTM A36 Structural Steel",
    "45钢 / AISI 1045": "Grade 45 Steel / AISI 1045",
    "304不锈钢": "304 Stainless Steel",
    "6061-T6铝合金": "6061-T6 Aluminum Alloy",
    "C30混凝土": "C30 Concrete",
    "C40混凝土": "C40 Concrete",
    "HT200灰铸铁": "HT200 Gray Cast Iron",
    "QT450-10球墨铸铁": "QT450-10 Ductile Iron",
    "C11000紫铜": "C11000 Copper",
    "C28000黄铜": "C28000 Brass",
    "Ti-6Al-4V钛合金": "Ti-6Al-4V Titanium Alloy",
    "新建材料": "New Material",
    "材料名称": "Material Name",
    "例如：Q235 钢、混凝土 C30": "For example: Q235 steel or C30 concrete",
    "弹性模量 E": "Elastic Modulus E",
    "泊松比 ν": "Poisson's Ratio ν",
    "密度 ρ": "Density ρ",
    "屈服强度": "Yield Strength",
    "抗拉强度": "Tensile Strength",
    "抗压强度": "Compressive Strength",
    "材料颜色": "Material Color",
    "材料颜色调色盘": "Material color palette",
    "来源 URL": "Source URL",
    "备注": "Notes",
    "牌号、假设、实验条件或数据出处": "Grade, assumptions, test conditions, or data source",
    "保存材料": "Save Material",
    "新建": "New",
    "正在读取项目材料文件...": "Loading project material file...",
    "浏览器检索材料属性": "Search material properties",
    "联网检索": "Online Search",
    "搜索引擎": "Search Engine",
    "选择搜索引擎": "Select search engine",
    "必应": "Bing",
    "输入材料名称或牌号": "Enter a material name or grade",
    "浏览器搜索": "Search Browser",
    "输入材料名称后，将在浏览器中搜索材料力学属性。": "Enter a material name to search the web for mechanical properties.",
    "安全": "Safe",
    "抗压超限": "Compression Limit Exceeded",
    "抗拉超限": "Tension Limit Exceeded",
    "屈服超限": "Yield Limit Exceeded",
    "播放中": "Playing",
    "空模型": "Empty Model",
    "网格失败": "Meshing Failed",
    "需重新布点": "Nodes Need Update",
    "需重新划分": "Mesh Needs Update",
    "已就绪": "Ready",
    "已同步": "Synced",
    "外部空气": "Exterior Air",
    "未填充材料": "No Material",
    "清除填充": "Clear Material",
    "材料库暂无材料。": "No materials are available.",
    "改为结构区域": "Convert to Structural Region",
    "设为外部空气": "Set as Exterior Air",
    "材料库中没有找到该材料。": "The material was not found in the library.",
    "编辑材料": "Edit Material",
    "删除材料": "Delete Material",
    "请输入材料名称。": "Enter a material name.",
    "请输入要检索的材料名称。": "Enter a material name to search for.",
    "属性待补充": "Properties not provided",
    "未连接项目材料文件。请通过 node server.js 打开程序后再保存。":
      "The project material file is not connected. Open the app through start.bat before saving.",
    "已读取项目材料文件；保存到项目文件夹需要通过 server.js 打开。":
      "The project material file was loaded. Open the app through start.bat to save changes.",
    "已读取内嵌材料库；保存到项目文件夹需要通过 server.js 打开。":
      "The embedded material library was loaded. Open the app through start.bat to save changes.",
    "暂无材料。创建后会保存在本地，下次打开仍可直接使用。":
      "No materials yet. New materials will be saved locally for future use.",
    "正在读取 calculation-data...": "Reading calculation-data...",
    "读取结果失败": "Failed to Load Results",
    "暂无结果文件": "No Result File",
    "无法读取 calculation-data 中的计算结果。": "Unable to read calculation results from calculation-data.",
    "当前浏览器不支持读取本地文件夹，请通过 start.bat 启动本地服务。":
      "This browser cannot read local folders. Start the local service with start.bat.",
    "没有选择计算数据文件夹。": "No calculation-data folder was selected.",
    "没有获得读取 calculation-data 文件夹的权限。": "Permission to read the calculation-data folder was not granted.",
    "二进制计算结果缺少节点或单元数据。": "The binary calculation result is missing node or element data.",
    "结果解析失败": "Failed to Parse Results",
    "暂无计算结果，请先在计算页开始计算，或点击左侧重新读取结果。":
      "No results are available. Run the analysis first or reload the results.",
    "真实位移 1倍": "True Displacement ×1",
    "等效应力": "Equivalent Stress",
    "等效应变": "Equivalent Strain",
    "位移幅值": "Displacement Magnitude",
    "应力四分窗": "Stress Components",
    "应变四分窗": "Strain Components",
    "左上为变形图；其余窗口按各自分量范围着色。":
      "The upper-left panel shows deformation; the others use each component's own color range.",
    "σxx / xx 方向": "σxx / xx Direction",
    "σxy / xy 方向": "σxy / xy Direction",
    "σyy / yy 方向": "σyy / yy Direction",
    "εxx / xx 方向": "εxx / xx Direction",
    "εxy / xy 方向": "εxy / xy Direction",
    "εyy / yy 方向": "εyy / yy Direction",
    "应力云图 σxx / xx 方向": "Stress Contours: σxx / xx Direction",
    "应力云图 σxy / xy 方向": "Stress Contours: σxy / xy Direction",
    "应力云图 σyy / yy 方向": "Stress Contours: σyy / yy Direction",
    "应变云图 εxx / xx 方向": "Strain Contours: εxx / xx Direction",
    "应变云图 εxy / xy 方向": "Strain Contours: εxy / xy Direction",
    "应变云图 εyy / yy 方向": "Strain Contours: εyy / yy Direction",
    "正在加载 Triangle…": "Loading Triangle…",
    "triangle-wasm 运行时未加载，无法划分有限元网格。": "The triangle-wasm runtime is unavailable; the finite element mesh cannot be generated.",
    "未识别到闭合结构区域，无法自动划分 TRI3 单元。": "No closed structural region was found; TRI3 elements cannot be generated.",
    "计算节点少于 3 个，无法生成三角形单元。": "At least three analysis nodes are required to generate triangular elements.",
    "Triangle 已运行，但没有生成可用的 TRI3 单元。": "Triangle completed but did not produce usable TRI3 elements.",
    "当前没有可布置计算节点的结构几何。": "There is no structural geometry on which to place analysis nodes.",
    "当前只有离散几何节点，未生成内部节点。": "Only isolated geometry nodes exist; no interior nodes were generated.",
    "未识别到闭合结构区域，本次只沿现有几何边界和几何节点布置计算节点。":
      "No closed structural region was found; analysis nodes were placed only along existing boundaries and geometry nodes.",
    "当前模型还没有计算节点；请先在计算页执行自动划分网格，或通过 setAnalysisMesh() 写入 analysisNodes。":
      "The model has no analysis nodes. Generate the mesh first or provide analysisNodes through setAnalysisMesh().",
    "当前模型还没有可导出的 TRI3 单元；请先在计算页执行自动划分网格，或通过 setAnalysisMesh() 写入 TRI3 单元。":
      "The model has no exportable TRI3 elements. Generate the mesh first or provide TRI3 elements through setAnalysisMesh().",
    "当前浏览器不支持调用本地计算服务；请通过 start.bat 或 node server.js 启动本地服务。":
      "This browser cannot call the local calculation service. Start the app with start.bat.",
    "当前浏览器不支持直接写入文件夹，请使用 Chrome/Edge 或通过 start.bat 启动本地服务。":
      "This browser cannot write directly to a folder. Use Chrome/Edge or start the app with start.bat.",
    "未连接到本地计算服务。": "The local calculation service is not connected.",
    "已取消选择文件夹，未写入计算输入文件。": "Folder selection was canceled; the calculation input was not written.",
    "没有可写入的文件夹句柄。": "No writable folder handle is available.",
    "没有获得写入文件夹的权限。": "Permission to write to the folder was not granted.",
    "读写计算数据文件夹缓存失败。": "Failed to access the cached calculation-data folder.",
    "计算数据文件夹缓存事务失败。": "The calculation-data folder cache transaction failed.",
    "计算数据文件夹缓存事务已中止。": "The calculation-data folder cache transaction was aborted.",
    "无法打开计算数据文件夹缓存。": "Unable to open the calculation-data folder cache.",
    "二进制计算完成，TXT 已生成": "Binary calculation complete; TXT files generated",
    "二进制计算完成（未生成 TXT）": "Binary calculation complete (no TXT files generated)",
    "正在运行 C++ 核心...": "Running the C++ solver...",
    "请从本地服务器打开": "Open the app through the local server",
    "输入生成失败": "Failed to Generate Input",
    "未连接本地服务": "Local service not connected",
    "C++ 计算失败": "C++ Calculation Failed",
    "m 或当前模型坐标单位": "m or the current model coordinate unit",
    "导入失败": "Import Failed"
  });

  const DYNAMIC_RULES = [
    [/^当前搜索引擎：(.+)$/u, (match) => `Current search engine: ${translateEnglishText(match[1])}`],
    [/^已用 (.+) 搜索：(.+)$/u, (match) => `Searched with ${translateEnglishText(match[1])}: ${match[2]}`],
    [/^已连接项目材料文件：(.+)$/u, (match) => `Connected to project material file: ${match[1]}`],
    [/^已保存到项目材料文件：(.+)$/u, (match) => `Saved to project material file: ${match[1]}`],
    [/^材料库保存失败：(.+)$/u, (match) => `Failed to save material library: ${translateEnglishText(match[1])}`],
    [/^材料库删除失败：(.+)$/u, (match) => `Failed to delete material: ${translateEnglishText(match[1])}`],
    [/^删除材料“(.+)”？$/u, (match) => `Delete material “${match[1]}”?`],
    [/^导入失败：(.+)$/u, (match) => `Import failed: ${translateEnglishText(match[1])}`],
    [/^已读取 (\d+) 个单元结果$/u, (match) => `Loaded results for ${match[1]} elements`],
    [/^(\d+) 单元$/u, (match) => `${match[1]} elements`],
    [/^已布点 (\d+) 节点$/u, (match) => `${match[1]} nodes placed`],
    [/^(\d+) 单元 \/ 二进制就绪$/u, (match) => `${match[1]} elements / binary ready`],
    [/^(\d+) 单元 \/ TXT已生成$/u, (match) => `${match[1]} elements / TXT generated`],
    [/^已覆盖 (.+)$/u, (match) => `Overwrote ${match[1]}`],
    [/^当前显示为真实位移的 (.+) 倍$/u, (match) => `Displayed at ${match[1]}× true displacement`],
    [/^(.+) 至 (.+)$/u, (match) => `${match[1]} to ${match[2]}`],
    [/^(.+)：外部空气$/u, (match) => `${match[1]}: Exterior Air`],
    [/^(.+)：未填充材料$/u, (match) => `${match[1]}: No Material`],
    [/^(.+) (结构|外部空气)$/u, (match) => `${match[1]} ${translateEnglishText(match[2])}`],
    [/^(state|kind): (.+)$/u, (match) => `${match[1]}: ${translateEnglishText(match[2])}`],
    [/^material: (.+)$/u, (match) => `material: ${translateEnglishText(match[1])}`],
    [/^(.+) 几何节点$/u, (match) => `${match[1]} Geometry Node`],
    [/^(.+) 几何点载荷$/u, (match) => `${match[1]} Point Load`],
    [/^(.+) 分布力$/u, (match) => `${match[1]} Distributed Load`],
    [/^(.+) 体力$/u, (match) => `${match[1]} Body Force`],
    [/^(.+) 边界$/u, (match) => `${match[1]} Boundary`],
    [/^(.+) 空气$/u, (match) => `${match[1]} Air`],
    [/^source: 边界交点 (.+)$/u, (match) => `source: boundary intersection ${match[1]}`],
    [/^计算失败：(.+)$/u, (match) => `Calculation failed: ${translateEnglishText(match[1])}`],
    [/^保存计算输入失败：HTTP (.+)$/u, (match) => `Failed to save calculation input: HTTP ${match[1]}`],
    [/^自适应求解 (\d+) \/ (\d+)$/u, (match) => `Adaptive solve ${match[1]} / ${match[2]}`],
    [/^自适应加密超过 ([\d.]+) 秒，已停止。$/u, (match) => `Adaptive refinement exceeded ${match[1]} seconds and was stopped.`],
    [/^自适应首轮求解超过 ([\d.]+) 秒，已停止；请减小基础网格规模或使用普通网格计算。$/u, (match) => `The initial adaptive solve exceeded ${match[1]} seconds and was stopped. Reduce the initial mesh size or use ordinary mesh calculation.`],
    [/^达到 ([\d.]+) 秒耗时保护，已保留最后成功结果；可尝试均匀网格$/u, (match) => `${match[1]}-second time protection reached; the last successful result was kept. Consider a uniform mesh`],
    [/^单元 (.+) 的应力结果缺失或无效，无法进行 ZZ 误差估计。$/u, (match) => `Element ${match[1]} has missing or invalid stress results; ZZ estimation cannot proceed.`],
    [/^单元 (.+)（区域 (.+)）的材料参数或面积无效，请检查区域材料和网格。$/u, (match) => `Element ${match[1]} (region ${match[2]}) has invalid material parameters or area. Check the region material and mesh.`],
    [/^自适应完成：(.+)；ZZ 估计误差 (.+)%$/u, (match) => `Adaptive calculation complete: ${translateEnglishText(match[1])}; ZZ estimated error ${match[2]}%`],
    [/^C\+\+ 计算失败：HTTP (.+)$/u, (match) => `C++ calculation failed: HTTP ${match[1]}`],
    [/^无法读取 (.+)：HTTP (.+)$/u, (match) => `Unable to read ${match[1]}: HTTP ${match[2]}`],
    [/^无法读取 (.+)，请确认选择的是项目根目录或 calculation-data 文件夹。$/u, (match) => `Unable to read ${match[1]}. Select the project root or calculation-data folder.`],
    [/^计算输入文件格式不支持：(.+)$/u, (match) => `Unsupported calculation input format: ${match[1]}`],
    [/^计算结果文件格式不支持：(.+)$/u, (match) => `Unsupported calculation result format: ${match[1]}`],
    [/^triangle-wasm 初始化失败：(.+)$/u, (match) => `Failed to initialize triangle-wasm: ${translateEnglishText(match[1])}`],
    [/^Triangle 剖分失败：(.+)$/u, (match) => `Triangle meshing failed: ${translateEnglishText(match[1])}`],
    [/^已排除 (\d+) 个未被任何 TRI3 单元引用的计算节点。$/u, (match) => `Excluded ${match[1]} analysis nodes not referenced by any TRI3 element.`],
    [/^(.+) 缺少有效的闭合外轮廓计算节点。$/u, (match) => `${match[1]} has no valid analysis-node loop for its outer boundary.`],
    [/^(.+) 内部区域 (.+) 缺少有效孔洞边界节点。$/u, (match) => `Interior region ${match[2]} of ${match[1]} has no valid hole-boundary nodes.`],
    [/^(.+) 内部区域 (.+) 无法确定孔洞种子点。$/u, (match) => `A hole seed point could not be determined for interior region ${match[2]} of ${match[1]}.`],
    [/^(.+) 的有效结构面积为零或为负，请检查嵌套区域。$/u, (match) => `The effective structural area of ${match[1]} is zero or negative; check nested regions.`],
    [/^(.+) 的边界发生自交或重复经过计算节点 (.+)。$/u, (match) => `The boundary of ${match[1]} self-intersects or passes through analysis node ${match[2]} more than once.`],
    [/^(.+) 返回了非 TRI3 或不完整的 Triangle 输出。$/u, (match) => `${match[1]} returned non-TRI3 or incomplete Triangle output.`],
    [/^(.+) 的 Triangle 输出引用了无效节点。$/u, (match) => `Triangle output for ${match[1]} references an invalid node.`],
    [/^(.+) 的 Triangle 输出含退化单元。$/u, (match) => `Triangle output for ${match[1]} contains a degenerate element.`],
    [/^(.+) 的 Triangle 输出越过了结构边界或孔洞。$/u, (match) => `Triangle output for ${match[1]} crosses a structural boundary or hole.`],
    [/^(.+) 有 (\d+) 条约束边未进入任何单元。$/u, (match) => `${match[1]} has ${match[2]} constrained edges that are not used by any element.`],
    [/^(.+) 网格覆盖校验失败：结构面积 (.+)，单元面积 (.+)。$/u, (match) => `Mesh coverage validation failed for ${match[1]}: structural area ${match[2]}, element area ${match[3]}.`],
    [/^已从求解输入中排除 (\d+) 个未被 TRI3 单元引用的计算节点，避免总体刚度矩阵出现零行列。$/u,
      (match) => `Excluded ${match[1]} analysis nodes not referenced by TRI3 elements to prevent zero rows or columns in the global stiffness matrix.`],
    [/^(.+) 被跳过：C\+\+ 输入口当前只导出三节点 TRI3 单元。$/u, (match) => `${match[1]} was skipped: the C++ input currently exports only three-node TRI3 elements.`],
    [/^(.+) 被跳过：存在找不到的计算节点引用。$/u, (match) => `${match[1]} was skipped because it references a missing analysis node.`],
    [/^(.+) 面积接近 0，请检查网格节点是否共线。$/u, (match) => `${match[1]} has near-zero area; check whether its mesh nodes are collinear.`],
    [/^(.+) 点载荷未匹配到计算节点，未写入全局节点载荷。$/u, (match) => `${match[1]} was not matched to an analysis node and was omitted from the global nodal loads.`]
  ];

  const sourceTextByNode = new WeakMap();
  const sourceAttributesByElement = new WeakMap();
  const sourceValueByElement = new WeakMap();
  let activeLanguage = readStoredLanguage();
  let mutationObserver = null;

  function readStoredLanguage() {
    try {
      const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      return SUPPORTED_LANGUAGES.has(stored) ? stored : "zh-CN";
    } catch (error) {
      return "zh-CN";
    }
  }

  function translateEnglishText(value) {
    const source = String(value ?? "");
    if (!source) return source;
    if (source.includes("\n")) {
      return source.split("\n").map((line) => translateEnglishText(line)).join("\n");
    }
    const leading = source.match(/^\s*/u)?.[0] || "";
    const trailing = source.match(/\s*$/u)?.[0] || "";
    const core = source.slice(leading.length, source.length - trailing.length || source.length);
    if (!core) return source;
    const exact = ENGLISH_TEXT[core];
    if (exact) return `${leading}${exact}${trailing}`;
    for (const [pattern, replacement] of DYNAMIC_RULES) {
      const match = core.match(pattern);
      if (match) return `${leading}${typeof replacement === "function" ? replacement(match) : core.replace(pattern, replacement)}${trailing}`;
    }
    return source;
  }

  function uiText(value) {
    return activeLanguage === "en" ? translateEnglishText(value) : String(value ?? "");
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parentTag = node.parentElement?.tagName;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parentTag)) return;
    const current = node.data;
    const knownSource = sourceTextByNode.get(node);
    if (activeLanguage === "en") {
      if (HAN_TEXT.test(current)) {
        sourceTextByNode.set(node, current);
        const translated = translateEnglishText(current);
        if (translated !== current) node.data = translated;
      } else if (knownSource && current !== translateEnglishText(knownSource)) {
        sourceTextByNode.delete(node);
      }
      return;
    }
    if (knownSource && current === translateEnglishText(knownSource)) {
      node.data = knownSource;
    }
  }

  function attributeSources(element) {
    let sources = sourceAttributesByElement.get(element);
    if (!sources) {
      sources = new Map();
      sourceAttributesByElement.set(element, sources);
    }
    return sources;
  }

  function translateAttribute(element, attributeName) {
    if (!element?.hasAttribute?.(attributeName)) return;
    const current = element.getAttribute(attributeName) || "";
    const sources = attributeSources(element);
    const knownSource = sources.get(attributeName);
    if (activeLanguage === "en") {
      if (HAN_TEXT.test(current)) {
        sources.set(attributeName, current);
        const translated = translateEnglishText(current);
        if (translated !== current) element.setAttribute(attributeName, translated);
      } else if (knownSource && current !== translateEnglishText(knownSource)) {
        sources.delete(attributeName);
      }
      return;
    }
    if (knownSource && current === translateEnglishText(knownSource)) {
      element.setAttribute(attributeName, knownSource);
    }
  }

  function translateInitialValue(element) {
    if (!(element instanceof HTMLInputElement) || !element.hasAttribute("value")) return;
    const current = element.value;
    const knownSource = sourceValueByElement.get(element);
    if (activeLanguage === "en") {
      if (HAN_TEXT.test(current)) {
        sourceValueByElement.set(element, current);
        const translated = translateEnglishText(current);
        if (translated !== current) element.value = translated;
      } else if (knownSource && current !== translateEnglishText(knownSource)) {
        sourceValueByElement.delete(element);
      }
      return;
    }
    if (knownSource && current === translateEnglishText(knownSource)) {
      element.value = knownSource;
    }
  }

  function translateElement(element) {
    if (!(element instanceof Element)) return;
    TRANSLATABLE_ATTRIBUTES.forEach((attributeName) => translateAttribute(element, attributeName));
    translateInitialValue(element);
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root instanceof Element) translateElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
      else translateElement(node);
      node = walker.nextNode();
    }
  }

  function observeDynamicInterfaceText() {
    if (typeof MutationObserver !== "function" || mutationObserver) return;
    mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") {
          translateTextNode(record.target);
        } else if (record.type === "attributes") {
          translateAttribute(record.target, record.attributeName);
        } else {
          record.addedNodes.forEach((node) => translateTree(node));
        }
      }
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES,
    });
  }

  function installLocalizedDialogs() {
    if (window.alert && !window.alert.__femLocalized) {
      const nativeAlert = window.alert.bind(window);
      const localizedAlert = (message) => nativeAlert(uiText(message));
      localizedAlert.__femLocalized = true;
      window.alert = localizedAlert;
    }
    if (window.confirm && !window.confirm.__femLocalized) {
      const nativeConfirm = window.confirm.bind(window);
      const localizedConfirm = (message) => nativeConfirm(uiText(message));
      localizedConfirm.__femLocalized = true;
      window.confirm = localizedConfirm;
    }
  }

  function installLocalizedCanvasText() {
    if (typeof CanvasRenderingContext2D === "undefined") return;
    for (const methodName of ["fillText", "strokeText"]) {
      const nativeMethod = CanvasRenderingContext2D.prototype[methodName];
      if (!nativeMethod || nativeMethod.__femLocalized) continue;
      const localizedMethod = function localizedCanvasText(text, ...args) {
        return nativeMethod.call(this, uiText(text), ...args);
      };
      localizedMethod.__femLocalized = true;
      CanvasRenderingContext2D.prototype[methodName] = localizedMethod;
    }
  }

  function refreshInterfaceAfterLanguageChange() {
    const refreshFunctions = [
      "updatePanel",
      "updateCalculationPanel",
      "render",
      "renderCalculationView",
      "renderResultView",
      "renderMaterialLibrary",
    ];
    refreshFunctions.forEach((name) => {
      if (typeof window[name] === "function") window[name]();
    });
  }

  function setLanguage(language, options = {}) {
    const nextLanguage = SUPPORTED_LANGUAGES.has(language) ? language : "zh-CN";
    activeLanguage = nextLanguage;
    document.documentElement.lang = nextLanguage;
    if (options.persist !== false) {
      try {
        window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLanguage);
      } catch (error) {
        // 存储不可用时仍保留本次会话中的语言选择。
      }
    }
    translateTree(document.documentElement);
    const selector = document.getElementById("interfaceLanguage");
    if (selector) selector.value = nextLanguage;
    if (options.refresh !== false) refreshInterfaceAfterLanguageChange();
    window.dispatchEvent(new CustomEvent("femlanguagechange", { detail: { language: nextLanguage } }));
  }

  function setupLanguageSelector() {
    const selector = document.getElementById("interfaceLanguage");
    if (!selector) return;
    selector.value = activeLanguage;
    selector.addEventListener("change", () => setLanguage(selector.value));
  }

  window.femI18n = {
    get language() {
      return activeLanguage;
    },
    setLanguage,
    t: uiText,
    translateEnglish: translateEnglishText,
  };
  window.uiText = uiText;

  installLocalizedDialogs();
  installLocalizedCanvasText();
  setupLanguageSelector();
  setLanguage(activeLanguage, { persist: false, refresh: false });
  observeDynamicInterfaceText();
})();
