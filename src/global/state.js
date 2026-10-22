/*
  全局状态和配置。
  负责集中保存 DOM 引用、常量、当前场景和跨页面共享的运行状态。
  页面功能代码放在 src/pages，通用几何/区域/分类逻辑放在 src/core。

  主要算法：
  - 曲线表示：直线直接线性插值，二次/三次曲线采用贝塞尔公式，圆弧由三点反求圆心。
  - 区域识别：把所有曲线离散成短线段，切分交点后构建半边图，再沿左侧面追踪闭合环。
  - 区域判定：先用线段距离容差判断边界命中，再用射线奇偶规则判断点是否在多边形内。
  - 网格分类：计算节点按所在几何/区域继承 static/free、材料和结构区域信息，单元按质心分类。
  - 渲染流程：canvas 每次状态变化后全量重绘，按“网格背景 -> 区域 -> 网格 -> 几何 -> 载荷 -> 高亮”的顺序叠加。
*/

// 画布和外层容器：外层用于测量尺寸，canvas 用于实际绘制。
const canvas = document.getElementById("viewport");
const wrap = document.getElementById("canvasWrap");
const ctx = canvas.getContext("2d");

// 左侧工具、顶部状态、载荷参数、右侧检查器等 UI 元素引用。
const toolButtons = [...document.querySelectorAll(".tool-button[data-tool]")];
const toolName = document.getElementById("toolName");
const coordReadout = document.getElementById("coordReadout");
const zoomReadout = document.getElementById("zoomReadout");
const modelName = document.getElementById("modelName");
const forceMagnitude = document.getElementById("forceMagnitude");
const loadMagnitude = document.getElementById("loadMagnitude");
const loadEndMagnitude = document.getElementById("loadEndMagnitude");
const bodyForceMagnitude = document.getElementById("bodyForceMagnitude");
const loadAngle = document.getElementById("loadAngle");
const loadDirectionButtons = [...document.querySelectorAll("[data-load-mode]")];
const bodyForceScopeButtons = [...document.querySelectorAll("[data-body-force-scope]")];
const snapToggle = document.getElementById("snapToggle");
const animationScale = document.getElementById("animationScale");
const animationButton = document.getElementById("toggleAnimation");
const animationIcon = document.getElementById("animationIcon");
const fileInput = document.getElementById("fileInput");
const selectionDetails = document.getElementById("selectionDetails");
const geometryEditor = document.getElementById("geometryEditor");
const geometryEditorTitle = document.getElementById("geometryEditorTitle");
const geometryStateButtons = [...document.querySelectorAll("[data-geometry-state]")];
const loadEditor = document.getElementById("loadEditor");
const loadEditorTitle = document.getElementById("loadEditorTitle");
const selectedLoadMagnitude = document.getElementById("selectedLoadMagnitude");
const selectedLoadEndRow = document.getElementById("selectedLoadEndRow");
const selectedLoadEndMagnitude = document.getElementById("selectedLoadEndMagnitude");
const selectedLoadAngle = document.getElementById("selectedLoadAngle");
const selectedLoadUnit = document.getElementById("selectedLoadUnit");
const pageTabs = [...document.querySelectorAll("[data-page-tab]")];
const pageViews = [...document.querySelectorAll("[data-page]")];
const regionMaterialMenu = document.getElementById("regionMaterialMenu");
const regionMaterialMenuRegion = document.getElementById("regionMaterialMenuRegion");
const regionMaterialMenuList = document.getElementById("regionMaterialMenuList");

// 计算页视窗和工具引用。计算页只读结构轮廓，不参与几何建模选择。
const calculationCanvas = document.getElementById("calculationViewport");
const calculationWrap = document.getElementById("calculationCanvasWrap");
const calculationCtx = calculationCanvas?.getContext("2d") || null;
const calculationToolButtons = [...document.querySelectorAll("[data-calculation-tool]")];
const calculationModeName = document.getElementById("calculationModeName");
const calculationCoordReadout = document.getElementById("calculationCoordReadout");
const calculationZoomReadout = document.getElementById("calculationZoomReadout");
const calculationModelName = document.getElementById("calculationModelName");
const calculationAnimationButton = null;
const calculationAnimationIcon = null;
const calculationDeformationScale = null;
const calculationLayerToggles = [...document.querySelectorAll("[data-calculation-layer]")];
const maxAnalysisNodes = document.getElementById("maxAnalysisNodes");
const generateCalculationTextFiles = document.getElementById("generateCalculationTextFiles");

// 计算结果页视窗和工具引用。结果页从 calculation-data 中读取 TXT 后独立渲染云图。
const resultCanvas = document.getElementById("resultViewport");
const resultWrap = document.getElementById("resultCanvasWrap");
const resultCtx = resultCanvas?.getContext("2d") || null;
const resultViewButtons = [...document.querySelectorAll("[data-result-view]")];
const resultModeName = document.getElementById("resultModeName");
const resultCoordReadout = document.getElementById("resultCoordReadout");
const resultZoomReadout = document.getElementById("resultZoomReadout");
const resultModelName = document.getElementById("resultModelName");
const resultDeformationScale = document.getElementById("resultDeformationScale");
const resultDeformationScaleValue = document.getElementById("resultDeformationScaleValue");
const resultDeformationScaleRecommended = document.getElementById("resultDeformationScaleRecommended");
const reloadCalculationResult = document.getElementById("reloadCalculationResult");
const fitResultView = document.getElementById("fitResultView");

const resultUi = {
  nodes: document.getElementById("resultNodeCount"),
  elements: document.getElementById("resultElementCount"),
  maxDisplacement: document.getElementById("resultMaxDisplacement"),
  unsafeCount: document.getElementById("resultUnsafeCount"),
  maxStress: document.getElementById("resultMaxStress"),
  maxStrain: document.getElementById("resultMaxStrain"),
  generatedAt: document.getElementById("resultGeneratedAt"),
  legend: document.getElementById("resultLegend"),
  status: document.getElementById("resultLoadStatus"),
};

// 计算页右侧统计和状态显示。
const calculationCounts = {
  analysisNodes: document.getElementById("calculationAnalysisNodeCount"),
  elements: document.getElementById("calculationElementCount"),
  regions: document.getElementById("calculationStructureRegionCount"),
  staticBoundaries: document.getElementById("calculationStaticBoundaryCount"),
  loads: document.getElementById("calculationLoadCount"),
};

const calculationStatuses = {
  geometry: document.getElementById("calculationGeometryStatus"),
  mesh: document.getElementById("calculationMeshStatus"),
  animation: document.getElementById("calculationAnimationStatus"),
};

// 材料库页面元素。
const materialUi = {
  form: document.getElementById("materialForm"),
  formTitle: document.getElementById("materialFormTitle"),
  id: document.getElementById("materialId"),
  name: document.getElementById("materialNameInput"),
  elasticModulus: document.getElementById("materialElasticModulus"),
  poissonRatio: document.getElementById("materialPoissonRatio"),
  density: document.getElementById("materialDensity"),
  yieldStrength: document.getElementById("materialYieldStrength"),
  tensileStrength: document.getElementById("materialTensileStrength"),
  compressiveStrength: document.getElementById("materialCompressiveStrength"),
  color: document.getElementById("materialColor"),
  sourceUrl: document.getElementById("materialSourceUrl"),
  notes: document.getElementById("materialNotes"),
  preview: document.getElementById("materialPreview"),
  swatches: document.getElementById("materialSwatches"),
  list: document.getElementById("materialList"),
  count: document.getElementById("materialCount"),
  newButton: document.getElementById("newMaterial"),
  storageStatus: document.getElementById("materialStorageStatus"),
  searchEngine: document.getElementById("materialSearchEngine"),
  searchInput: document.getElementById("materialSearchInput"),
  openSearch: document.getElementById("openMaterialSearch"),
  searchStatus: document.getElementById("materialSearchStatus"),
};

// 右侧对象数量统计元素。
const counts = {
  geometryNodes: document.getElementById("nodeCount"),
  analysisNodes: document.getElementById("analysisNodeCount"),
  curves: document.getElementById("curveCount"),
  regions: document.getElementById("regionCount"),
  loads: document.getElementById("loadCount"),
  mesh: document.getElementById("meshCount"),
};

// 工具枚举到中文显示名的映射。
const TOOL_LABELS = {
  select: "选择",
  node: "几何节点",
  line: "直线",
  quadratic: "二次曲线",
  cubic: "三次曲线",
  arc: "圆弧",
  eraser: "橡皮擦",
  force: "点载荷",
  distributed: "分布力",
  body: "体力",
};

// 计算页按钮到状态条名称的映射；真实功能会在后续网格/求解阶段接入。
const CALCULATION_TOOL_LABELS = {
  "analysis-nodes": "布置计算节点",
  "auto-mesh": "自动划分网格",
  "start-calculation": "开始计算",
  "refine-once": "迭代加密一次",
};

// 计算结果页四种显示模式。
const RESULT_VIEW_LABELS = {
  deformation: "变形图",
  stress: "应力云图",
  strain: "应变云图",
  safety: "安全校核图",
  damage: "损伤云图",
  tnt: "TNT 爆破可视化",
};

// 画布绘制用颜色，集中管理便于后续接入主题。
const COLORS = {
  canvasBackground: "#f8fafc",
  airRegion: "rgba(248, 250, 252, 0.88)",
  axis: "#2d3a45",
  grid: "#dbe2e8",
  gridMajor: "#c8d2dc",
  node: "#0067b1",
  nodeFill: "#ffffff",
  curve: "#263442",
  selected: "#007c89",
  control: "#7b65b2",
  static: "#5f6f1d",
  force: "#c4422f",
  load: "#a55b00",
  bodyLoad: "#2f8f46",
  mesh: "#7b65b2",
  regionStroke: "#007c89",
  regionLabel: "#273442",
  ghost: "rgba(0, 124, 137, 0.35)",
  resultMesh: "#536171",
  resultOriginalMesh: "rgba(83, 97, 113, 0.26)",
  resultDeformedMesh: "#007c89",
};

const RESULT_RAMP_COLORS = ["#2f6fb3", "#2aa876", "#f2c94c", "#e76f51", "#b42318"];
const RESULT_SAFETY_COLORS = {
  0: "#2f8f46",
  1: "#f2c94c",
  2: "#e76f51",
  3: "#b42318",
};
const RESULT_SAFETY_LABELS = {
  0: "安全",
  1: "抗压超限",
  2: "抗拉超限",
  3: "屈服超限",
};

const REGION_PALETTE = [
  "#007c89",
  "#b87333",
  "#2f8f46",
  "#c49a35",
  "#7b65b2",
  "#c4422f",
  "#0067b1",
  "#596579",
];

// 材料库存放在项目 materials 文件夹中；旧版 localStorage 会在启动时清理。
const MATERIAL_API_URL = "./api/materials";
const MATERIAL_FILE_URL = "./materials/materials.json";
const LEGACY_MATERIAL_STORAGE_KEY = "fem-sketch-material-library-v1";
const SEARCH_ENGINE_PREFERENCE_KEY = "fem-sketch-material-search-engine";
const MATERIAL_SWATCHES = [
  "#007c89",
  "#0067b1",
  "#7b65b2",
  "#c4422f",
  "#a55b00",
  "#2f8f46",
  "#475569",
  "#8b5e34",
  "#d97706",
  "#0f766e",
];
const MATERIAL_SEARCH_HINT = "Young modulus Poisson ratio density yield strength tensile strength mechanical properties";
const MATERIAL_SEARCH_ENGINES = {
  google: {
    label: "Google",
    makeUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  },
  bing: {
    label: "必应",
    makeUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  },
  yahoo: {
    label: "Yahoo",
    makeUrl: (query) => `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`,
  },
};
let materialLibrary = [];
let materialStorageConnected = false;

// 命中测试和节点显示半径，单位是屏幕像素。
const HIT_PX = 10;
const GEOMETRY_NODE_SNAP_PX = HIT_PX;
const NODE_R = 5;

// 区域识别和分类使用的数值容差。曲线先采样，再在交点处切分，因此这些容差决定了闭合环是否能稳定合并。
const DEFAULT_CLASSIFICATION_TOLERANCE = 1e-4;
const REGION_SAMPLE_COUNT = 72;
const MIN_REGION_AREA = 1e-5;
const REGION_POINT_MERGE_TOLERANCE = 1e-6;
const REGION_INTERSECTION_TOLERANCE = 1e-8;
const INTERSECTION_NODE_TOLERANCE = 1e-5;
const INTERSECTION_NODE_ROLE = "curveIntersection";
const REGION_KIND_STRUCTURE = "structure";
const REGION_KIND_AIR = "air";

// scene 是核心数据模型：几何节点和计算节点分开保存，避免后续网格/求解阶段混淆。
let scene = emptyScene();

// 当前工具和设备像素比。
let activeTool = "select";
let dpr = window.devicePixelRatio || 1;

// 视图变换参数：世界坐标通过 offset + scale 映射到屏幕坐标。
let view = {
  width: 800,
  height: 600,
  offsetX: 400,
  offsetY: 300,
  scale: 48,
};

// 计算页有独立的视图变换，避免在计算预览中缩放/平移时影响结构绘制页。
let calculationDpr = window.devicePixelRatio || 1;
let calculationView = {
  width: 800,
  height: 600,
  offsetX: 400,
  offsetY: 300,
  scale: 48,
};

let resultDpr = window.devicePixelRatio || 1;
let resultView = {
  width: 800,
  height: 600,
  offsetX: 400,
  offsetY: 300,
  scale: 48,
};

// 图层可见性开关。
let layers = {
  regions: true,
  geometry: true,
  loads: true,
  mesh: true,
};

// 计算页图层开关。structure 始终代表“区域材料色 + 边界骨架”，不显示几何节点和编号。
let calculationLayers = {
  structure: true,
  loads: true,
  analysisNodes: true,
  mesh: true,
  deformation: true,
};

let activeRegionMenuId = null;

// 交互状态：interaction 表示正在拖动/平移/绘制，draft 表示未完成的新对象。
let interaction = null;
let draft = null;

// 当前选中对象和鼠标悬停对象。
let selected = null;
let hovered = null;

// 载荷方向输入模式：drag 为手绘方向，input 为角度预输入。
let loadDirectionMode = "drag";
let bodyForceScope = "region";

// 动画状态：后续接入有限元位移结果后，可使用 analysisNodes 中的 ux/uy。
let animation = {
  running: false,
  time: 0,
  frame: null,
};

// 计算页动画状态独立于绘图页动画，后续可接真实求解结果的变形播放。
let activeCalculationTool = "";
let calculationInteraction = null;
let calculationAnimation = {
  running: false,
  time: 0,
  frame: null,
};
let calculationRunStatusMessage = "";

let activeResultView = "deformation";
let resultInteraction = null;
let calculationResultData = null;

// 创建一个空场景；导入失败或清空时也复用这个结构。
function emptyScene() {
  return {
    version: 6,
    name: "未命名模型",
    geometryNodes: [],
    curves: [],
    regions: [],
    pointLoads: [],
    distributedLoads: [],
    bodyLoads: [],
    analysisNodes: [],
    analysisNodePlacement: null,
    mesh: {
      elements: [],
      metadata: null,
    },
    nextIds: {
      geometryNode: 1,
      analysisNode: 1,
      curve: 1,
      region: 1,
      pointLoad: 1,
      distributedLoad: 1,
      bodyLoad: 1,
    },
  };
}
