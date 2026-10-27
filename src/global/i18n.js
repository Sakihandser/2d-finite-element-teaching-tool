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
    "当前环境不支持选择保存位置，请使用启动器打开程序。": "This environment cannot choose a save location. Open the program with the launcher.",
    "本构与计算条件不兼容": "Material model and calculation conditions are incompatible",
    "返回调整条件或本构": "Return to change conditions or material model",
    "当前设置无法计算，请修改条件或本构。": "Calculation is blocked. Change the conditions or material model.",
    "本构适用条件": "Material model requirements",
    "有限变形无法使用平面应力。请将二维假设改为平面应变，或将运动学改为小变形。": "Finite deformation cannot use plane stress. Select plane strain or small deformation.",
    "该超弹性本构无法使用平面应力。请改为平面应变，或更换固体本构。": "This hyperelastic model cannot use plane stress. Select plane strain or a different solid model.",
    "该超弹性本构需要有限变形。请更换运动学条件，或更换固体本构。": "This hyperelastic model requires finite deformation. Change the kinematics or solid model.",
    "该本构目前只支持小变形。请将运动学改为小变形，或更换固体本构。": "This model currently supports only small deformation. Change the kinematics or solid model.",
    "MCC 不能从零初始应力突然加载。请选择先静力平衡，并施加正有效围压，或更换本构。": "MCC cannot start from zero stress with sudden loading. Equilibrate under positive effective confinement or select a different model.",
    "MCC 尚未设置正有效围压或压缩外载荷。请设置初始压缩条件，或更换本构。": "MCC has no positive confinement or compressive external load. Configure initial compression or select a different model.",
    "MCC 需要正初始有效围压，初始应力须在屈服面内；没有孔隙水求解，不能模拟拉伸状态。": "MCC requires positive initial effective confinement and stress inside its yield surface. Pore-water flow and tensile states are excluded.",
    "该本构尚不支持非零预载的非线性静力初始化。请选择起爆时突然施加外载荷，或更换本构。": "This model does not support nonlinear static initialization with nonzero preload. Select sudden loading or a different material model.",
    "产物余容积 b (m³/kg)": "Products covolume b (m3/kg)",
    "产物压力偏移 p∞ (MPa)": "Products pressure offset pinf (MPa)",
    "产物参考能量 q (MJ/kg，非负)": "Products energy reference q (MJ/kg, nonnegative)",
    "产物吸引系数 a (Pa·m⁶/kg²)": "Products attraction a (Pa m6/kg2)",
    "间隙气体状态方程": "Gap gas equation of state",
    "气体余容积 b (m³/kg)": "Gas covolume b (m3/kg)",
    "气体压力偏移 p∞ (MPa)": "Gas pressure offset pinf (MPa)",
    "气体参考能量 q (MJ/kg，非负)": "Gas energy reference q (MJ/kg, nonnegative)",
    "气体吸引系数 a (Pa·m⁶/kg²)": "Gas attraction a (Pa m6/kg2)",
    "理想气体": "Ideal gas",
    "Noble–Abel 气体": "Noble-Abel gas",
    "刚性气体 (Stiffened Gas)": "Stiffened gas",
    "Noble–Abel 刚性气体 (NASG)": "Noble-Abel stiffened gas (NASG)",
    "van der Waals 气体（单相高温）": "van der Waals gas (single high-temperature phase)",
    "理想气体采用常比热比，不含分子排斥、吸引或相变。": "Ideal gas uses a constant heat-capacity ratio; molecular repulsion, attraction and phase change are excluded.",
    "JWL 用于已经反应的爆轰产物，需要独立标定的系数和内能；不计算爆轰反应前沿。": "JWL describes reacted detonation products using calibrated coefficients and energy; it does not resolve the reaction front.",
    "等效 CJ 为理想产物近似，不能替代高密度炸药的标定 JWL，也不计算反应前沿。": "Equivalent CJ is an ideal-products approximation, not a substitute for calibrated JWL for dense explosives; the reaction front is excluded.",
    "Noble–Abel 用余容积描述稠密气体排斥；必须满足 bρ < 1，且内能大于参考能量 q；不含相变。": "Noble-Abel uses covolume for dense-gas repulsion. Require b*rho < 1 and energy above q; phase change is excluded.",
    "刚性气体用压力偏移模拟可压缩介质，是常比热的经验近似；需独立标定，不能直接当作真实气体物性。": "Stiffened gas is an empirical constant-heat-capacity approximation using a pressure offset. It requires calibration and is not a real-gas property database.",
    "NASG 同时考虑余容积和压力偏移；要求 bρ < 1、正压力和正声速平方；不含相变。": "NASG combines covolume and pressure offset. Require b*rho < 1, positive pressure and positive sound speed squared; phase change is excluded.",
    "van der Waals 仅支持高于临界温度的稳定单相区和常定容比热；不求相平衡，接近临界区或进入非双曲区会停止。": "Van der Waals supports a stable single phase above critical temperature with constant Cv. Phase equilibrium is excluded; leaving the supported domain stops the calculation.",
    "气体密度和内能必须为正，并满足 bρ < 1。": "Gas density and internal energy must be positive, with b*rho < 1.",
    "van der Waals 状态必须位于高于临界温度的正压力、稳定单相区。请调整密度、内能或更换 EOS。": "Van der Waals requires a stable, positive-pressure single phase above critical temperature. Change density, energy or EOS.",
    "气体 EOS 必须保持内能大于 q、正压力和正声速平方。请调整参数或更换 EOS。": "Gas EOS requires energy above q, positive pressure and positive sound speed squared. Change parameters or EOS.",
    "非理想气体参数必须有限，比热比大于 1，余容积、压力偏移、参考能量和吸引系数非负。": "Nonideal gas parameters must be finite, gamma must exceed one, and covolume, pressure offset, energy reference and attraction must be nonnegative.",
    "该 EOS 需要大于 0 的余容积 b。": "This EOS requires positive covolume b.",
    "该 EOS 需要大于 0 的压力偏移 p∞。": "This EOS requires a positive pressure offset pinf.",
    "van der Waals 需要大于 0 的吸引系数 a。": "Van der Waals requires positive attraction a.",
    "非理想气体暂不支持当前轴向泄流公式。请选择两端封堵，或改用理想气体 / JWL。": "Nonideal gases do not support the current axial discharge formula. Select sealed ends or use ideal gas / JWL.",
    "非理想气体使用通用 HLLC 通量；强膨胀返回采用局部多方近似。需检查网格和时间步收敛，不包含反应或相变。": "Nonideal gases use general HLLC fluxes and a local polytropic approximation for strong expansion. Check mesh/time-step convergence; reactions and phase change are excluded.",
    "请重新编译计算核心以使用所选气体状态方程。": "Rebuild the native core for the selected gas EOS.",
    "非理想气体本构参数无效。": "Invalid nonideal gas constitutive parameters.",
    "所选气体 EOS 需要正余容积。": "Selected gas EOS requires positive covolume.",
    "所选气体 EOS 需要正压力偏移。": "Selected gas EOS requires positive pressure offset.",
    "van der Waals 需要正吸引系数。": "Van der Waals requires positive attraction.",
    "气体密度和内能必须为正，余容积与密度乘积必须小于一。": "Gas density/internal energy must be positive and covolume times density below one.",
    "van der Waals 需要高于临界温度的稳定单相状态。": "Van der Waals requires a stable single phase above the critical temperature.",
    "气体内能必须高于参考能量。": "Gas internal energy must exceed its energy reference.",
    "非理想气体 EOS 超出正压力或双曲区域。": "Nonideal gas EOS left the positive-pressure or hyperbolic domain.",
    "非理想气体目前要求轴向两端封堵。": "Nonideal gases currently require sealed axial ends.",
    "固体本构与破坏后的气体响应": "Solid constitutive models and post-failure gas response",
    "默认固体本构": "Default solid constitutive model",
    "J2 / Von Mises 弹塑性": "J2 / Von Mises elastoplasticity",
    "广义 Maxwell / Prony 黏弹性": "Generalized Maxwell / Prony viscoelasticity",
    "Neo-Hookean 超弹性": "Neo-Hookean hyperelasticity",
    "Modified Cam-Clay（常弹性）": "Modified Cam-Clay (constant elasticity)",
    "DP-Cap（椭圆帽盖）": "DP-Cap (elliptical cap)",
    "J2 / Perzyna 黏塑性": "J2 / Perzyna viscoplasticity",
    "正交各向异性弹性": "Orthotropic elasticity",
    "Mooney–Rivlin 超弹性": "Mooney–Rivlin hyperelasticity",
    "HJC 混凝土（连续压实）": "HJC concrete (continuous compaction)",
    "J2：三维径向返回与线性等向硬化，适用于金属屈服；不含断裂。": "J2: 3D radial return and linear isotropic hardening for metal yielding; fracture is excluded.",
    "JC：塑性应变率强化、等向硬化及绝热升温软化；不含 JC 断裂和热传导。": "JC: plastic strain-rate strengthening, isotropic hardening and adiabatic thermal softening; JC fracture and heat conduction are excluded.",
    "MC：主应力空间多屈服面返回，包含棱边、顶点、非关联剪胀和拉伸截断。": "MC: multisurface return in principal stress space, including edges, apex, nonassociated dilation and tension cutoff.",
    "Prony：瞬时 E、ν 来自基础材料，体积弹性不松弛；最多四个剪切松弛支路，Σg < 1。": "Prony: base E and nu are instantaneous values, with elastic bulk response and up to four shear-relaxation branches; sum(g) < 1.",
    "Neo-Hookean：等容剪切能与 K(J−1)²/2 体积能；须使用有限变形和平面应变。": "Neo-Hookean: isochoric shear energy and K(J-1)^2/2 volumetric energy; requires finite deformation and plane strain.",
    "MCC：常弹性变体，E、ν 来自基础材料；关联流动及预固结硬化，须先施加正有效围压，不包含孔隙水求解。": "MCC: constant-elasticity variant using base E and nu, associated flow and preconsolidation hardening; requires positive effective confinement. Pore-water flow is excluded.",
    "DP-Cap：DP 剪切面与连续椭圆压缩帽盖、非关联剪胀和线性压实硬化；不是商业求解器的全部 Cap 选项。": "DP-Cap: DP shear surface with a continuous elliptical compression cap, nonassociated dilation and linear compaction hardening; commercial Cap options are not all implemented.",
    "Perzyna：隐式过应力积分、线性等向硬化；时间尺度越小越接近率无关 J2。": "Perzyna: implicit overstress integration and linear isotropic hardening; a smaller time scale approaches rate-independent J2.",
    "正交各向异性：九个独立弹性常数和面内材料方向，要求柔度矩阵正定；当前使用小变形。": "Orthotropic: nine independent elastic constants and in-plane material orientation, with positive definite compliance; currently uses small deformation.",
    "Mooney–Rivlin：C₁₀(Ī₁−3)+C₀₁(Ī₂−3)+K(J−1)²/2；须使用有限变形和平面应变。": "Mooney-Rivlin: C10(I1bar-3)+C01(I2bar-3)+K(J-1)^2/2; requires finite deformation and plane strain.",
    "HJC：压力和应变率强化、塑性损伤及不可逆体积压实；采用连续三段压实 EOS，无单元侵蚀。": "HJC: pressure/rate strengthening, plastic damage and irreversible volumetric compaction, with a continuous three-stage EOS; element erosion is excluded.",
    "初始屈服应力 (MPa)": "Initial yield stress (MPa)",
    "等向硬化模量 H (MPa)": "Isotropic hardening modulus H (MPa)",
    "初始屈服 A (MPa)": "Initial yield A (MPa)",
    "硬化系数 B (MPa)": "Hardening coefficient B (MPa)",
    "硬化指数 n": "Hardening exponent n",
    "参考塑性应变率 (1/s)": "Reference plastic strain rate (1/s)",
    "热软化指数 m": "Thermal softening exponent m",
    "参考温度 (K)": "Reference temperature (K)",
    "熔化温度 (K)": "Melting temperature (K)",
    "初始温度 (K)": "Initial temperature (K)",
    "比热 (J/kg/K)": "Specific heat (J/kg/K)",
    "塑性功转热比例 (0–1)": "Plastic heat fraction (0-1)",
    "黏聚力 (MPa)": "Cohesion (MPa)",
    "拉伸截断强度 (MPa)": "Tensile cutoff strength (MPa)",
    "剪切模量 G (MPa)": "Shear modulus G (MPa)",
    "体积模量 K (MPa)": "Bulk modulus K (MPa)",
    "临界状态斜率 M": "Critical state slope M",
    "压缩指数 λ": "Compression index lambda",
    "回弹指数 κ": "Swelling index kappa",
    "初始孔隙比 e₀": "Initial void ratio e0",
    "初始预固结压力 pc (MPa)": "Initial preconsolidation pressure pc (MPa)",
    "DP 截距 d (MPa)": "DP intercept d (MPa)",
    "DP 摩擦角 β (°)": "DP friction angle beta (degrees)",
    "DP 剪胀角 (°)": "DP dilation angle (degrees)",
    "初始帽盖中心 pa (MPa)": "Initial cap center pa (MPa)",
    "帽盖长宽比 R": "Cap aspect ratio R",
    "压实硬化模量 (MPa)": "Compaction hardening modulus (MPa)",
    "黏塑性时间尺度 (ms)": "Viscoplastic time scale (ms)",
    "过应力指数 n": "Overstress exponent n",
    "材料 1 轴方向 (°)": "Material axis 1 orientation (degrees)",
    "黏聚强度 A": "Cohesive strength A",
    "压力强化 B": "Pressure hardening B",
    "压力指数 N": "Pressure exponent N",
    "归一化抗压强度 fc (MPa)": "Normalizing compressive strength fc (MPa)",
    "归一化强度上限": "Normalized strength limit",
    "最小破坏应变": "Minimum failure strain",
    "压碎压力 (MPa)": "Crush pressure (MPa)",
    "压碎体积压缩 μc": "Crush volumetric compression muc",
    "锁定压力 (MPa)": "Lock pressure (MPa)",
    "锁定体积压缩 μl": "Lock volumetric compression mul",
    "密实体积模量 K1 (GPa)": "Dense bulk modulus K1 (GPa)",
    "密实 EOS K2 (GPa)": "Dense EOS K2 (GPa)",
    "密实 EOS K3 (GPa)": "Dense EOS K3 (GPa)",
    "请完整填写材料卡（含所有零值），单位见字段标签。": "Complete the material card, including zero values; use the units shown on each field.",
    "参数范围或弹性正定性无效，请查阅 docs/SOLID_CONSTITUTIVE.md。": "Invalid parameter range or nonpositive elasticity; see docs/SOLID_CONSTITUTIVE.md.",
    "超弹性须选择有限变形和平面应变。": "Hyperelasticity requires finite deformation and plane strain.",
    "此模型当前须选择小变形。": "This model currently requires small deformation.",
    "请重新编译计算核心以使用所选固体本构。": "Rebuild the native core for the selected solid model.",
    "固体材料卡版本不受支持。": "Unsupported solid material card version.",
    "固体本构参数格式错误。": "Malformed solid material parameters.",
    "固体本构参数不完整。": "Incomplete solid material parameters.",
    "固体本构参数无效或弹性柔度非正定。": "Invalid solid constitutive parameters or nonpositive elastic compliance.",
    "超弹性材料需要有限变形和平面应变。": "Hyperelastic materials require finite deformation and plane strain.",
    "Maxwell、MCC 和正交各向异性材料目前需要小变形。": "Maxwell, MCC and orthotropic materials currently require small deformation.",
    "固体塑性返回无法括定根。": "Solid plastic return could not bracket a root.",
    "MC 主应力分解失败。": "MC principal stress decomposition failed.",
    "MC 多屈服面返回未收敛，请减小应变增量。": "MC active-surface return did not converge; reduce the strain increment.",
    "MCC 需要正有效压力，不支持拉伸状态。": "MCC requires positive effective pressure; tensile states are unsupported.",
    "HJC 体积塌缩，请减小应变增量。": "HJC volume collapsed; reduce the strain increment.",
    "超弹性变形梯度已经倒置或塌缩。": "Hyperelastic deformation gradient is inverted or collapsed.",
    "超弹性伸长比非正。": "Hyperelastic stretch is nonpositive.",
    "固体更新需要有限应变增量和正时间步。": "Solid update requires a finite strain increment and positive time step.",
    "超弹性更新需要总变形梯度。": "Hyperelastic updates require the total deformation gradient.",
    "固体状态出现非有限值，请检查参数和时间步。": "Non-finite solid state; check parameters and time step.",
    "MCC 需要正初始有效围压。": "MCC requires positive initial effective confinement.",
    "超弹性或 HJC 初始预载需要非线性静力初始化，请选择突然加载。": "Hyperelastic/HJC initial preload requires nonlinear static initialization; choose sudden loading.",
    "初始平衡已超过固体屈服面，需要非线性静力初始化。": "Initial equilibrium exceeds solid yield; nonlinear static initialization is required.",
    "归一化应力可直接填写 σHEL；填 0 时按 σHEL = 1.5 × (HEL − pHEL) 换算。EOS K1 控制初始体积刚度；β 和参考长度须独立标定。": "Enter sigmaHEL directly, or use zero to derive sigmaHEL = 1.5 (HEL - pHEL). EOS K1 controls initial bulk stiffness; beta and reference length require calibration.",
    "正在保存本构参数…": "Saving constitutive cards…",
    "小变形结果存在大应变，请采用有限变形对照并检查网格。": "Large strain in a small-deformation result; compare finite deformation and inspect the mesh.",
    "连通裂隙储气与压力反馈（均压近似）": "Connected fracture storage and pressure feedback (uniform pressure approximation)",
    "炮孔轴向端部条件": "Axial borehole end conditions",
    "两端封堵（无轴向流出）": "Both ends sealed (no axial discharge)",
    "单端敞开": "One end open",
    "两端敞开": "Both ends open",
    "试件厚度 / 有效孔长 (mm)": "Specimen thickness / effective borehole length (mm)",
    "封堵解除时间 (ms，0 初始敞开)": "Opening time (ms; 0 means initially open)",
    "敞开端按均匀储罐的可压缩泄流近似计算，流出质量和能量单独守恒记账。封堵模式不启用此泄流；端部条件应按实际试验选择。薄空气夹层可能明显增加显式求解耗时，请检查气体网格敏感性与计算时限。": "Open ends use a compressible tank-discharge approximation with escaping mass and energy accounted for. Select end conditions to match the experiment. Thin air layers can substantially slow the explicit solver; check gas-mesh sensitivity and the runtime limit.",
    "基础计算页的均匀网格和自适应网格均可直接复用；本按钮重新生成普通网格。材料需填写密度和所选本构的参数。": "Both ordinary and adaptive meshes can be reused. This button generates an ordinary mesh. Assign density and parameters for the selected material model.",
    "轴向端部几何或开启时间无效。": "Invalid axial vent geometry or opening time.",
    "轴向泄流需要大于一的等熵指数。": "Axial discharge requires an isentropic exponent greater than one.",
    "轴向泄流超出正质量或正能量范围。": "Axial discharge left the positive mass/energy domain.",

    "强稀疏气流需要大于一的局部等熵指数。": "Strong gas expansion requires positive isentropic exponents.",
    "气体膨胀形成了物理真空，需要支持真空的流体方法。": "Physical vacuum formed in gas expansion; a vacuum-capable fluid method is required.",
    "无法括定非线性气体接触压力。": "Nonlinear gas contact pressure could not be bracketed.",
    "岩石本构与破坏后的气体响应": "Rock constitutive models and post-failure gas response",
    "默认岩石本构": "Default rock constitutive model",
    "拉伸损伤（裂带）": "Tensile damage (crack band)",
    "线弹性": "Linear elasticity",
    "Drucker–Prager + 拉伸损伤": "Drucker–Prager + tensile damage",
    "JH2": "JH2",
    "岩体运动学": "Rock kinematics",
    "小变形": "Small deformation",
    "有限变形与旋转（平面应变，自适应时间步）": "Finite deformation and rotation (plane strain, adaptive time step)",
    "气体与破坏区耦合": "Gas coupling with the failure zone",
    "仅炮孔容积": "Cavity volume only",
    "裂隙连通损伤阈值 (0–1)": "Damage threshold for fracture connectivity (0–1)",
    "保存各材料本构参数": "Save constitutive cards",
    "连通裂隙储气仅计入与炮孔连通且张开的损伤区，同时施加气体压力反馈并记录储气功；不等同于沿裂缝求解气流或三维碎块接触。": "Fracture storage includes open damage connected to the cavity, with pressure feedback and separate storage work. It does not resolve flow along cracks or 3D fragment contact.",
    "启用损伤演化（按所选本构）": "Enable damage evolution for the selected material model",
    "JH2 包含塑性损伤与破碎强度；各模型的损伤变量含义不同。当前仍采用二维连续网格，不包含碎块接触。气体模式从起爆后产物初态开始。": "JH2 includes plastic damage and fractured strength; damage definitions differ between models. The 2D continuum mesh does not include fragment contact. Gas calculations start with reacted products.",
    "随全局本构": "Use default material model",
    "本构参数已保存。": "Constitutive cards saved.",
    "裂带拉伸软化描述张拉开裂；需要实测单轴抗拉强度和断裂能。": "Crack-band tensile softening requires measured uniaxial tensile strength and fracture energy.",
    "线弹性用于检查波传播和加载，不产生损伤或塑性耗能。": "Linear elasticity checks wave propagation and loading without damage or plastic dissipation.",
    "DP 描述压力相关剪切屈服，并叠加拉伸软化；需要实测单轴强度、摩擦角和剪胀角。": "DP combines pressure-dependent shear yielding with tensile softening and requires measured uniaxial strengths, friction and dilation angles.",
    "JH2 用于爆破等高速载荷，计算压力相关强度、应变率、塑性损伤和破碎剩余强度。T 为静水拉伸强度。": "JH2 models pressure-dependent strength, strain rate, plastic damage and fractured residual strength under rapid loading. T is hydrostatic tensile strength.",
    "有限变形当前仅支持平面应变，请先切换二维假设。": "Finite deformation currently requires plane strain.",
    "岩石本构或裂隙储气设置无效。": "Invalid rock or fracture-storage selection.",
    "无法读取岩石本构参数卡。": "Cannot read rock material cards.",
    "岩石本构参数卡格式错误。": "Malformed rock material card.",
    "岩石本构参数卡编号无效或重复。": "Invalid/duplicate rock material card.",
    "所选岩石本构需要完整的材料参数卡。": "Selected rock model requires a material card.",
    "JH2 参数无效，请检查材料卡。": "Invalid JH2 parameters.",
    "JH2 压缩状态方程切线非正，请检查 K1/K2/K3。": "JH2 compression EOS is not hyperbolic.",
    "DP 需要单轴抗压、抗拉强度以及有效摩擦角和剪胀角。": "DP requires compression/tension strengths and valid friction/dilation angles.",
    "有限变形网格已经倒置或塌缩，此工况需要重网格或粒子求解器。": "Finite-deformation mesh inverted/collapsed; this case requires remeshing or a particle solver.",
    "有限变形伸长张量无效。": "Invalid finite-deformation stretch.",
    "初始平衡已超过 JH2 强度，需要非线性静力初始化。": "Initial equilibrium exceeds JH2 strength; nonlinear static initialization is required.",
    "初始平衡已超过 DP 强度，需要非线性静力初始化。": "Initial equilibrium exceeds DP strength; nonlinear static initialization is required.",
    "有限变形达到步数上限，严重畸变网格需要重网格。": "Finite-deformation step limit reached; severely distorted mesh requires remeshing.",
    "有限变形稳定步长已塌缩，需要重网格或粒子求解器。": "Finite-deformation CFL step collapsed; use remeshing or a particle solver.",
    "岩石体积已塌缩，请细化网格、减小时间步或使用粒子求解器。": "Rock volume collapsed; refine mesh/time step or use a particle solver.",
    "岩石主应力分解失败。": "Rock principal stress decomposition failed.",
    "拉伸损伤需要实测抗拉强度及兼容的断裂能和网格。": "Tensile damage needs measured ft and a compatible Gf/mesh.",
    "岩石应力出现非有限值，请检查本构参数及时间步。": "Non-finite rock stress; check constitutive parameters and time step.",
    "岩石应变增量过大，请减小时间步。": "Rock strain increment too large; reduce time step.",
    "岩石平面应力返回未收敛，请减小时间步或采用平面应变。": "Rock plane-stress return did not converge; reduce time step or use plane strain.",
    "请重新编译计算核心以使用所选岩石本构。": "Rebuild the native core for the selected rock model.",
    "不支持此爆破单元数据布局。": "Unsupported blast cell layout.",
    "完整强度 A": "Intact strength A",
    "完整强度指数 N": "Intact exponent N",
    "破碎强度 B": "Fractured strength B",
    "破碎强度指数 M": "Fractured exponent M",
    "应变率系数 C": "Strain-rate coefficient C",
    "参考应变率 (1/s)": "Reference strain rate (1/s)",
    "HEL 纵向应力 (GPa)": "Longitudinal HEL stress (GPa)",
    "HEL 压力 (GPa)": "HEL pressure (GPa)",
    "静水拉伸强度 T (MPa)": "Hydrostatic tensile strength T (MPa)",
    "损伤系数 D1": "Damage coefficient D1",
    "损伤指数 D2": "Damage exponent D2",
    "归一化破碎强度上限": "Normalized fractured strength limit",
    "膨胀能量比例 β (0–1)": "Bulking energy fraction beta (0–1)",
    "损伤参考长度 (mm，0 不作长度修正)": "Damage reference length (mm; 0: no length correction)",
    "归一化等效应力 σHEL (GPa，0 由 HEL 换算)": "Normalization stress sigmaHEL (GPa; 0 derives from HEL)",
    "摩擦角 (°)": "Friction angle (degrees)",
    "剪胀角 (°)": "Dilation angle (degrees)",
    "爆破计算进度": "Blast calculation progress",
    "爆破进度连接中断，请重新计算。": "Blast progress connection interrupted. Run the calculation again.",
    "渲染：WebGL（GPU）": "Rendering: WebGL (GPU)",
    "渲染：Canvas 2D（WebGL 不可用）": "Rendering: Canvas 2D (WebGL unavailable)",
    "下载连接已关闭。": "Download closed.",
    "参数库": "Library",
    "参数": "Parameters",
    "空气": "Air",
    "材料": "Material",
    "参数库已在其他窗口修改，请重新读取后保存。": "Parameter library changed in another window. Reload before saving.",
    "无法连接程序服务，请检查服务和网络。": "Failed to fetch",
    "无法读取爆破帧，请重新计算。": "Failed to load blast frame.",
    "爆破帧包含非有限值。": "Non-finite blast frame header.",
    "爆破帧数据不完整。": "Incomplete blast frame.",
    "爆破帧标量布局不受支持。": "Unsupported blast frame scalar count.",
    "爆破帧维度无效。": "Invalid blast frame dimensions.",
    "爆破帧超过 256 MiB。": "Blast frame exceeds 256 MiB.",

    "花岗岩": "Granite",
    "青砂岩": "Green sandstone",
    "爆破历史不可用，请重新计算。": "Blast history is unavailable. Run the simulation again.",
    "正在读取爆破帧…": "Loading blast frame…",
    "暂无爆破损伤结果。": "No blast damage results yet.",
    "气体求解需要重新编译核心并重启程序服务。": "Rebuild the core and restart the server for gas dynamics.",
    "模型在计算期间发生变化，请重新计算。": "The model changed during calculation. Run again.",
    "爆破计算失败。": "Blast simulation failed.",
    "爆破计算已取消。": "Blast calculation cancelled.",
    "装药半径大于实际炮孔半径，请减小装药半径。": "Charge radius exceeds the cavity radius.",
    "炮孔、压力、时间、损伤或帧数参数无效。": "Invalid blast radius, pressure, times, damage or frame count.",
    "边界、围压或计算时限参数无效。": "Invalid blast boundary, confinement or time limit.",
    "气体来源或状态方程类型无效。": "Invalid gas source or EOS mode.",
    "气体来源或产物状态方程类型无效。": "Invalid gas source or product EOS mode.",
    "气体或产物参数无效；JWL 模型需要标定的膨胀系数。": "Invalid gas/products parameters; JWL requires calibrated expansion coefficients.",
    "炮孔半径和时间必须为正、压力非负，脉冲时长不能超过模拟时长。": "Blast radius/times must be positive, pressure nonnegative, pulse <= duration.",
    "径向气体单元数必须是 16 到 2048 的整数。": "Gas cells must be an integer from 16 to 2048.",
    "等效 CJ 模型需要正的爆速和能量。": "Equivalent CJ model requires positive detonation velocity and energy.",
    "时间积分、边界或载荷参数无效。": "Invalid blast integration/boundary/load settings.",
    "爆破计算需要有效的节点和单元。": "Blast requires model nodes and elements.",
    "爆破计算需要三角形网格。": "Blast requires a triangular mesh.",
    "单元面积、密度、弹性模量必须为正，泊松比必须在 -1 和 0.5 之间。": "Blast elements require positive area, density, E and -1 < nu < 0.5.",
    "爆源中心必须位于网格中明确建立的圆形炮孔内。": "Blast center must lie in an explicitly meshed circular cavity.",
    "拉伸损伤需要正的抗拉强度且 Gf/h > ft²/(2E)；请细化网格或检查材料与断裂能。": "Fracture needs positive tensile strength and Gf/h > ft^2/(2E); refine mesh or check material/Gf.",
    "时间步超过稳定性或压力分辨率限制；请将时间步设为 0 自动计算。": "Requested blast dt exceeds stability or pressure-resolution limit; use dt=0.",
    "计算步数超过两千万；请检查过小单元或模拟时长。": "Blast needs over 20 million steps; check tiny elements or simulation duration.",
    "爆破计算发散；请检查网格、材料或时间步。": "Blast solution diverged; check mesh/material/time step.",
    "初始弹性平衡状态已超过抗拉强度，当前不支持预损伤静力平衡；请检查围压、材料或损伤设置。": "Initial elastic equilibrium already exceeds tensile strength. Pre-damaged static equilibrium is not supported; check confinement/material or disable damage.",
    "初始应力平衡刚度矩阵奇异；请检查约束及不连通网格。": "Initial stress equilibrium stiffness is singular; check constraints and disconnected mesh.",
    "初始应力平衡求解失败。": "Initial stress equilibrium solve failed.",
    "外载荷无法在无刚体反力条件下平衡；请添加实际支撑、平衡合力与力矩或选择突然加载。": "External loads cannot equilibrate without rigid-body reactions. Add physical supports, balance forces/moments, or select sudden loading.",
    "未找到与爆源中心和半径匹配、且至少含 6 条边的闭合圆孔。": "No closed circular cavity with at least 6 boundary edges matches blast center/radius.",
    "炮孔边界必须形成完整闭环。": "Blast cavity boundary must be a complete closed loop.",
    "模型没有可运动的自由度。": "Blast model has no movable degrees of freedom.",
    "气固耦合中的平均炮孔面积已塌缩。": "Mean cavity area collapsed in gas coupling.",
    "气体密度或比内能非正。": "Nonpositive gas density/internal energy.",
    "气体网格翻转或比内能变为非正。": "Gas mesh inverted or internal energy became nonpositive.",
    "气体黎曼状态达到真空或非正压力。": "Gas Riemann state reached vacuum/nonpositive pressure.",
    "气体状态超出状态方程的正压或双曲区域；请检查材料参数。": "Gas EOS left its positive-pressure/hyperbolic domain; check material parameters.",
    "气体保守重映射超出状态方程的物理范围。": "Conservative gas rezoning left the physical EOS domain.",
    "气体时间步趋于零；请检查状态方程或炮孔严重塌缩。": "Gas timestep collapsed; check EOS or severe cavity collapse.",
    "气体子步反复超出物理状态范围。": "Gas step repeatedly left the physical state domain.",
    "径向气体分辨率或几何参数无效。": "Invalid radial gas resolution/geometry.",
    "装药必须位于气体炮孔内部。": "Charge must fit inside gas cavity.",
    "产物或 JWL 材料参数无效。": "Invalid products/JWL material parameters.",
    "空气材料参数无效。": "Invalid air material parameters.",
    "气体推进目标无效。": "Invalid gas advance target.",
    "已有两个爆破计算正在运行，请等待或取消其中一个。": "Two blast calculations are already running. Wait or cancel a run before starting another.",
    "爆破历史已过期，请重新计算。": "Blast history expired. Run the simulation again.",
    "爆破历史已过期或帧不存在，请重新计算。": "Blast history expired or frame does not exist. Run the simulation again.",
    "爆破数据流版本不支持，请重新编译计算核心。": "Unsupported blast stream; rebuild the C++ core.",
    "计算核心不支持气体动力学，请重新编译并重启程序。": "Native core does not support gas dynamics; rebuild and restart the program.",
    "爆破计算核心执行失败。": "Native blast solver failed.",
    "炸药条目编号或名称无效，请填写名称。": "Invalid explosive ID/name.",
    "气体条目编号或名称无效，请填写名称。": "Invalid gas ID/name.",
    "参考 CJ 压力必须为正或留空。": "Invalid CJ pressure.",
    "炸药条目无效。": "Invalid explosive record.",
    "气体条目无效。": "Invalid gas record.",
    "炸药库数据无效。": "Invalid explosive library.",
    "气体库数据无效。": "Invalid gas library.",
    "炸药库存在重复编号。": "Duplicate explosive IDs.",
    "气体库存在重复编号。": "Duplicate gas IDs.",
    "炸药库版本号无效。": "Invalid explosive library revision.",
    "爆破历史存储槽位已全部占用。": "All blast history slots are in use.",
    "爆破数据流提前结束，部分帧未能接收。": "Native blast stream ended before all frames arrived.",
    "爆破数据流末尾存在异常数据。": "Unexpected trailing blast stream data.",
    "爆破边界边数据无效。": "Invalid blast boundary edge.",
    "爆破元数据长度无效。": "Invalid blast metadata length.",
    "爆破数据流维度无效。": "Invalid blast stream dimensions.",
    "爆破帧摘要无效。": "Invalid blast frame summary.",
    "压缩结果超过 4 GiB，请减少保存帧数或模拟时长。": "Compressed blast history exceeds 4 GiB. Reduce saved frames or duration.",
    "超过 128 MiB 的结果必须按帧读取。": "Use lazy:true for histories larger than 128 MiB.",
    "爆破网格存在重复节点编号。": "Duplicate blast node number.",
    "爆破网格存在非流形边。": "Blast mesh contains a nonmanifold edge.",
    "无法读取爆破边界覆盖设置。": "Cannot read blast boundary overrides.",
    "爆破边界覆盖设置无效。": "Invalid blast boundary override.",
    "边界覆盖设置必须引用实际外边界网格边。": "Boundary override must reference a true exterior mesh edge.",
    "爆破边界覆盖设置重复。": "Duplicate blast boundary override.",
    "爆破边界覆盖文件格式无效。": "Malformed blast boundary override file.",
    "所选压力边界不是炮孔壁。": "Selected pressure boundary is not a cavity wall.",
    "存在不连通节点或无效质量、刚度。": "Unconnected node or invalid blast mass/stiffness.",
    "写入爆破帧数据流失败。": "Failed writing streamed blast frame.",
    "JWL 需要填写膨胀系数；验证时可使用理想产物模型。": "JWL requires user-supplied expansion coefficients; use ideal products for verification.",
    "单个爆破帧超过 256 MiB，请拆分模型。": "A single blast frame exceeds 256 MiB; partition the model.",

    "拉伸损伤需要每种岩石的单轴抗拉强度。以下数值单位为 MPa；填写后运行时保存到材料库，不重新划分网格。": "Tensile damage requires each rock's uniaxial tensile strength in MPa. Values are saved to the material library when running; the mesh is retained.",
    "保存抗拉强度到材料库": "Save tensile strengths to material library",
    "单轴抗拉强度 (MPa)": "Uniaxial tensile strength (MPa)",
    "必须填写正值": "Enter a positive value",
    "请补齐各材料的单轴抗拉强度后运行；不会自动用静水拉伸强度替代。": "Enter each material's uniaxial tensile strength before running. Hydrostatic tensile strength is not substituted.",
    "请填写大于 0 的单轴抗拉强度 (MPa)。": "Enter a positive uniaxial tensile strength (MPa).",
    "抗拉强度已保存；当前网格继续复用。": "Tensile strengths saved; the current mesh is retained.",
    "拉伸损伤需要每种岩石的单轴抗拉强度，单位 MPa；运行时保存到材料库。若网格与断裂能不匹配，自动局部细化并保留输入参数。JH2 静水拉伸强度不能直接代替单轴抗拉强度。": "Enter each rock's uniaxial tensile strength in MPa; values are saved to the library on running. An incompatible damage mesh is locally refined while retaining the input parameters. JH2 hydrostatic tensile strength cannot directly replace uniaxial tensile strength.",
    "当前损伤细化网格可复用；运行时按当前强度与断裂能复查。": "The refined damage mesh can be reused; current strength and fracture energy are checked on running.",
    "正在按断裂能与抗拉强度细化损伤网格…": "Refining the damage mesh for fracture energy and tensile strength…",
    "损伤网格缺少材料数据。": "The damage mesh is missing material data.",
    "损伤网格细化未能收敛，请检查材料、模型单位与断裂能。": "Damage mesh refinement did not converge; check materials, model units and fracture energy.",
    "损伤网格已达到最小单元面积，无法继续细化；请检查材料、模型单位与断裂能。": "The damage mesh has reached the minimum element area; check materials, model units and fracture energy.",
    "损伤网格细化超过 60 秒，已停止；请缩小模型范围或检查材料参数。": "Damage mesh refinement exceeded 60 seconds; reduce the model size or check material parameters.",
    "损伤网格细化失败。": "Damage mesh refinement failed.",
    "缺少单轴抗拉强度：": "Missing uniaxial tensile strength: ",
    "。请在“时间积分与损伤”中填写，单位 MPa。": ". Enter it under Time Integration and Damage in MPa.",
    "损伤网格与断裂能不匹配：当前 Gf = ": "Damage mesh/energy mismatch: current Gf = ",
    " 要求 Gf > ": " requires Gf > ",
    " J/m²。请细化网格或检查已标定的强度、断裂能。": " J/m². Refine the mesh or check calibrated strength and fracture energy.",

    "爆破库": "Blast Library",
    "爆破参数列表": "Blast parameter list",
    "参数类别": "Parameter category",
    "气体": "Gas",
    "新建参数": "New parameter set",
    "爆破参数编辑": "Blast parameter editor",
    "参数编辑": "Parameter editor",
    "在这里管理常用参数；保存到库后，可在爆破设置中选择使用。": "Manage reusable parameters here, then select them in Blast Setup.",
    "参数来源": "Parameter source",
    "保存参数": "Save parameters",
    "应用到爆破设置 →": "Apply to Blast Setup →",
    "管理 TNT / 炸药库 →": "Manage TNT / explosive library →",
    "管理气体库 →": "Manage gas library →",
    "参数已保存到爆破库。": "Parameters saved to Blast Library.",
    "删除所选参数？当前模型中的计算参数仍然保留。": "Delete the selected parameters? The current model retains its settings.",
    "已删除所选参数。": "Selected parameters deleted.",
    "参数库已重新读取。": "Library reloaded.",
    "请先保存参数，再应用到爆破设置。": "Save the parameters before applying them to Blast Setup.",

    "计算方式与炮孔": "Calculation method and borehole",
    "计算方式": "Calculation method",
    "直接输入孔壁压力和脉冲时长，即可计算岩体响应。": "Enter wall pressure and pulse duration to compute the rock response.",
    "根据炸药与间隙气体参数计算孔壁压力，请在下方选择或填写材料参数。": "Wall pressure is computed from the explosive and gap gas. Select or enter their parameters below.",
    "炸药与间隙气体": "Explosive and gap gas",
    "TNT / 炸药": "TNT / Explosive",
    "间隙气体": "Gap gas",
    "备注与炸药库管理": "Notes and explosive library management",
    "备注与气体库管理": "Notes and gas library management",
    "气体耦合模型说明": "About the gas-coupling model",
    "修改上方参数后可更新当前条目，或填写名称另存为新条目。参考爆速与 CJ 压力仅作记录。": "Edit the parameters above to update this entry, or enter a name to save a new entry. Reference speed and CJ pressure are recorded as metadata.",
    "修改上方参数后可更新当前气体，或填写名称另存为新气体。": "Edit the parameters above to update this gas, or enter a name to save a new gas.",
    "气体参数库": "Gas Library",
    "选择常用气体（选择后填入）": "Choose a gas (fills its parameters)",
    "手动输入 / 新建气体": "Manual input / New gas",
    "气体参数名称": "Gas parameter set name",
    "气体来源与备注": "Gas sources and notes",
    "保存当前气体参数": "Save current gas parameters",
    "另存为新气体": "Save as new gas",
    "删除所选气体": "Delete selected gas",
    "重新读取气体库": "Reload gas library",
    "在下方编辑气体密度、初始压力和比热比，再保存到气体库。选择气体不改变炸药、几何、围压或时间步。": "Edit gas density, initial pressure and heat-capacity ratio below, then save to the gas library. Selecting a gas preserves explosives, geometry, confinement and time step.",
    "已填入气体参数，炸药和其他计算设置保持原值。": "Gas parameters filled; explosive and other settings are retained.",
    "气体参数已保存到项目参数库，重启后仍可使用。": "Gas parameters saved to the project library and retained after restart.",
    "无法保存气体库，请重启程序服务后重试。": "Cannot save the gas library. Restart the program server and retry.",
    "删除所选气体参数？已保存模型内的计算参数仍然保留。": "Delete the selected gas? Parameters in saved models are retained.",
    "已删除所选气体参数。": "Selected gas deleted.",
    "TNT / 炸药参数库": "TNT / Explosive Library",
    "选择常用炸药（选择后填入）": "Choose an explosive (fills its parameters)",
    "手动输入 / 新建炸药": "Manual input / New explosive",
    "参数名称": "Parameter set name",
    "参考爆速 D (m/s)": "Reference detonation speed D (m/s)",
    "参考 CJ 压力 (GPa，可留空)": "Reference CJ pressure (GPa, optional)",
    "参数来源与备注": "Parameter sources and notes",
    "保存当前产物参数": "Save current product parameters",
    "另存为新条目": "Save as new entry",
    "删除所选条目": "Delete selected entry",
    "重新读取参数库": "Reload library",
    "先在下方编辑产物状态方程与参数，再保存到库。JWL 的参考爆速和 CJ 压力用于记录，不直接作为孔壁压力施加。选择炸药不改变几何、空气、围压或时间步。": "Edit the product EOS and parameters below, then save to the library. JWL reference detonation speed and CJ pressure are recorded, not imposed as wall pressure. Selecting an explosive preserves geometry, air, confinement and time step.",
    "已填入炸药参数；修改后可保存更新或另存为新条目。": "Explosive parameters filled. Edit and save or save as a new entry.",
    "炸药参数已保存到项目参数库，重启后仍可使用。": "Explosive parameters saved to the project library and retained after restart.",
    "删除所选炸药参数？已保存模型内的计算参数仍然保留。": "Delete the selected explosive? Parameters in saved models are retained.",
    "已删除所选炸药参数。": "Selected explosive deleted.",
    "无法保存炸药库，请重启程序服务后重试。": "Cannot save the explosive library. Restart the program server and retry.",
    "气体—岩体耦合验证（非 TNT 标定）": "Gas-rock verification (not calibrated TNT)",
    "压力来源": "Pressure source",
    "材料参数 → 气体动力学计算孔壁压力": "Material parameters → gas-dynamics wall pressure",
    "直接给定孔壁压力脉冲": "Prescribed wall-pressure pulse",
    "此模式直接给定孔壁压力时程；如需计算空气传播，请切换到材料参数模式。": "This mode prescribes wall pressure. Select the material mode to compute air propagation.",
    "常规参数（密度、爆速、爆热）": "Common parameters (density, detonation speed, heat release)",
    "自定比热比（理想气体验证）": "Custom heat-capacity ratio (ideal-gas verification)",
    "爆速 D (m/s)": "Detonation speed D (m/s)",
    "常规参数采用强 CJ 理想产物近似：γ = √(1 + D² / 2Q)，比内能填写爆热 Q。这是瞬时产物膨胀近似，不计算爆轰前沿；高密度炸药优先使用标定的 JWL。": "Common parameters use the strong-CJ ideal-products approximation: γ = √(1 + D² / 2Q); enter heat release Q as specific energy. Products expand from an instantaneous initial state; a detonation front is not solved. Calibrated JWL is preferable for condensed explosives.",
    "损伤带用于表示裂纹扩展，不包含碎块接触与压碎。气体模式从起爆后产物初态开始。": "Damage bands represent crack growth; fragment contact and crushing are excluded. Gas mode starts from post-detonation products.",
    "TNT 图标仅表示装药位置。孔壁压力由所选的气体模型或给定压力模式决定。": "The TNT icon indicates charge location only. Wall pressure comes from the selected gas model or prescribed-pressure mode.",
    "起爆后产物与空气": "Post-detonation products and air",
    "同心圆孔的径向气体动力学与二维岩体连接：产物在起始时刻已反应，计算膨胀、空气冲击及孔壁功。此处示范值用于数值验证，实际材料需要标定；未包含有限速率反应与再燃。": "Radial gas dynamics in a concentric cavity coupled to 2D rock. Products are reacted initially; expansion, air shocks and wall work are computed. Demonstration values are for numerical verification; real materials require calibration. Finite-rate chemistry and afterburn are excluded.",
    "产物材料": "Product material",
    "产物状态方程": "Product equation of state",
    "等效理想气体（简化验证）": "Effective ideal gas (verification)",
    "JWL（使用标定系数）": "JWL (calibrated coefficients)",
    "装药初始密度 (kg/m³)": "Initial charge density (kg/m³)",
    "起爆后比内能 (MJ/kg)": "Post-detonation internal energy (MJ/kg)",
    "产物比热比 γ": "Product heat-capacity ratio γ",
    "间隙气体与离散": "Gap gas and discretization",
    "气体初始密度 (kg/m³)": "Initial gas density (kg/m³)",
    "气体初始压力 (MPa)": "Initial gas pressure (MPa)",
    "气体比热比 γ": "Gas heat-capacity ratio γ",
    "径向气体单元数": "Radial gas cells",
    "气体在内部 CFL 子步上推进，平均孔壁变形反馈给气体。需同时检查气体网格、岩体网格和时间步收敛；孔壁尖峰对分辨率敏感。": "Gas advances in CFL substeps with mean wall-deformation feedback. Check gas mesh, rock mesh and time-step convergence; wall-pressure spikes are resolution-sensitive.",
    "产物初态": "Initial products",
    "气体加载": "Gas loading",
    "空气传播中": "Air-wave propagation",
    "装药半径 (m)": "Charge radius (m)",
    "孔壁峰值压力 (MPa)": "Peak wall pressure (MPa)",
    "炮孔半径 (m，自动识别)": "Cavity radius (m, detected)",
    "识别或运行时读取": "Read on detection or run",
    "径向空气间隙：": "Radial air gap: ",
    "空气间隙": "Air gap",
    "实际孔壁将在识别或运行时读取；装药半径可小于炮孔半径。": "The wall is read on detection or run; the charge may be smaller than the cavity.",
    "同心装药允许保留空气间隙。采用给定孔壁压力时程；空气压力传播需要另建空气与岩体耦合模型。": "Concentric charges may have an air gap. A prescribed wall-pressure history is used; air-wave propagation requires an air-rock coupling model.",
    "未在装药中心找到闭合圆形孔壁。请修正中心或识别实际炮孔；装药半径可以小于炮孔半径。": "No closed circular wall matches the charge center. Correct the center or detect the actual cavity; the charge can be smaller than the cavity.",
    "装药中心对应多个圆形孔壁，请先明确实际炮孔。": "Multiple circular walls share this center. Identify the actual cavity first.",
    "已识别实际孔壁；装药半径保持不变。孔壁边数：": "Actual wall identified; charge radius preserved. Wall edges: ",
    "识别并填入炮孔": "Detect and fill cavity parameters",
    "选择要起爆的圆孔": "Select the cavity to blast",
    "请选择要起爆的圆孔": "Choose a cavity",
    "发现多个圆孔，请选择要起爆的圆孔；不会自动替换为其他孔。": "Multiple cavities found. Choose the cavity to blast; no other cavity is selected automatically.",
    "当前实体网格没有闭合内孔。请将炮孔设为外部空气区域，并更新网格。": "The solid mesh has no closed internal hole. Set the cavity to external air and update the mesh.",
    "网格内孔未识别为圆孔。请检查孔壁形状，确认圆孔中心、半径与网格一致。": "No circular cavity was identified. Check the wall shape and ensure the center and radius match the mesh.",
    "炮孔参数与网格孔壁不匹配。": "Cavity parameters do not match the meshed wall.",
    "当前参数：": "Current parameters: ",
    "最近圆孔：": "Nearest circular cavity: ",
    "孔壁边数": "Wall edges",
    "孔壁至少需要 6 条网格边，请细化网格。": "The cavity needs at least 6 boundary edges. Refine the mesh.",
    "请使用“识别并填入炮孔”，或手动修正中心与半径后运行；无需仅因参数不匹配而重划网格。": "Detect and fill cavity parameters, or correct the center and radius manually. A parameter mismatch alone does not require remeshing.",
    "请等待当前计算结束后识别炮孔。": "Wait for the current calculation to finish before detecting cavities.",
    "请先生成或更新有效网格；基础计算页的均匀网格和自适应网格均可使用。": "Generate or update a valid mesh first. Both ordinary and adaptive meshes from the basic workspace can be used.",
    "网格已变化，请重新识别炮孔。": "The mesh has changed. Detect cavities again.",
    "已从当前网格填入炮孔：": "Cavity parameters filled from the current mesh: ",
    "炮孔与网格匹配。孔壁边数：": "Cavity matches the mesh. Wall edges: ",
    "尚未生成网格；可在基础计算页或本页生成。": "No mesh yet. Generate it in the basic workspace or on this page.",
    "当前网格已过期，运行时将更新网格。": "The mesh is outdated and will be updated when the simulation starts.",
    "当前自适应网格可直接用于爆破，无需重新划分。": "The current adaptive mesh can be used for blast analysis without remeshing.",
    "当前普通网格可直接用于爆破，无需重新划分。": "The current ordinary mesh can be used for blast analysis without remeshing.",
    "基础计算页的均匀网格和自适应网格均可直接复用；本按钮重新生成普通网格。材料需填写密度和抗拉强度。": "Both ordinary and adaptive meshes from the basic workspace can be reused. This button generates a new ordinary mesh. Assign material density and tensile strength.",
    "爆破设置": "Blast Setup",
    "爆破结果": "Blast Results",
    "专业计算": "Specialties",
    "基础": "Basic",
    "基础 + 爆破": "Basic + Blast",
    "选择计算专业": "Calculation specialties",
    "基础功能始终启用，按需添加专业工具。": "Basic tools are always enabled. Add specialty tools as needed.",
    "基础 · 静力学": "Basic · Statics",
    "几何、载荷、网格与静力计算": "Geometry, loads, meshing and static analysis",
    "爆破模拟": "Blast Simulation",
    "瞬态应力波、损伤与 TNT 可视化": "Transient stress waves, damage and TNT visualization",
    "专业计算 / 瞬态动力学": "SPECIALTY / TRANSIENT DYNAMICS",
    "设置炮孔、围压与边界条件，观察应力波传播和拉伸损伤。": "Configure the cavity, confinement and boundaries to study stress waves and tensile damage.",
    "查看爆破结果 →": "View blast results →",
    "取消计算": "Cancel",
    "炮孔与压力脉冲": "Cavity and pressure pulse",
    "坐标单位为 m，厚度为 1 m。炮孔应在结构绘制中建为圆形外部空气区域，孔壁至少有 6 条网格边。": "Coordinates in meters, thickness 1 m. Draw a circular external-air cavity with at least 6 cavity mesh edges.",
    "围压与外载荷": "Confinement and external loads",
    "正值表示压缩。围压施加于最外层边界，并与模型已有点力、分布力和体力叠加。深部岩石建议先静力平衡。": "Positive values mean compression. Confinement acts on outermost boundaries in addition to existing loads. Equilibrate first for deep rock.",
    "编辑模型与外载荷 →": "Edit model and loads →",
    "边界与反射": "Boundaries and reflection",
    "全局条件用于外边界；可按曲线编号单独覆盖。炮孔壁由压力脉冲控制，内部材料界面不受影响。吸收边界释放原有固定约束，交角处固定优先。": "Global conditions apply to outer boundaries, with overrides by curve ID. Cavity pulse loading and material interfaces are unchanged. Absorbing edges release fixities; fixed corners take precedence.",
    "按曲线单独设置边界": "Override individual boundaries",
    "时间积分与损伤": "Time integration and damage",
    "半正弦孔壁压力。损伤带用于表示裂纹扩展，不包含碎块接触、压碎或炸药反应。": "Half-sine cavity pressure. Cracks are represented by damage bands; fragment contact, crushing and explosive reactions are excluded.",
    "结果与计算资源": "Output and computing resources",
    "结果逐帧压缩保存，浏览器按需读取。保存帧数控制回放精度，不改变求解时间步。": "Frames are compressed and loaded on demand. Frame count controls playback sampling, not the solver time step.",
    "准备模型后即可运行。": "Prepare a model, then run the simulation.",
    "模型预览": "Model preview",
    "TNT 图标是装药位置示意，压力由脉冲参数指定。": "The TNT icon marks the charge location; pulse parameters define the pressure.",
    "编辑几何": "Edit geometry",
    "网格准备": "Mesh preparation",
    "目标节点上限": "Target node limit",
    "生成 / 更新网格": "Generate / update mesh",
    "与基础计算共用模型和网格；爆破使用普通网格。材料需填写密度和抗拉强度。": "The model and mesh are shared with statics. Blast analysis uses a non-adaptive mesh. Assign density and tensile strength to materials.",
    "爆破模型与炮孔位置预览": "Blast model and cavity position preview",
    "请在爆破设置页运行模拟。": "Run a simulation on the Blast Setup page.",
    "暂无爆破结果，请在爆破设置页运行模拟。": "No blast results yet. Run a simulation on the Blast Setup page.",
    "未读取静力学结果": "No static results loaded",
    "节点上限须为正整数。": "Node limit must be a positive integer.",
    "正在生成网格…": "Generating mesh…",
    "网格已更新。": "Mesh updated.",
    "请先在结构绘制页创建或导入模型": "Create or import a model on the Structure page first",
    "二维模型，坐标单位须为 m，厚度为 1 m。先画圆形炮孔并设为外部空气，给实体材料填写密度和抗拉强度。孔壁至少 6 条网格边。": "2D model, coordinates in meters, thickness 1 m. Create a circular air cavity and assign density and tensile strength to the solid. Use at least 6 cavity mesh edges.",
    "二维假设": "2D assumption",
    "平面应力（薄板）": "Plane stress (thin plate)",
    "平面应变（深部截面）": "Plane strain (deep section)",
    "最长计算时间（秒）": "Calculation time limit (s)",
    "外载荷加载方式": "External load initialization",
    "先静力平衡，再保持外载荷": "Equilibrate first, then maintain loads",
    "起爆时突然施加外载荷": "Apply loads suddenly at blast start",
    "水平围压（MPa）": "Horizontal confinement (MPa)",
    "竖直围压（MPa）": "Vertical confinement (MPa)",
    "围压以正值表示压缩，施加在最外层边界，并与已有点力、分布力和体力相加。模拟深层岩石时优先选择先静力平衡。": "Positive confinement means compression on the outermost boundaries, added to existing point, distributed and body loads. For deep rock, equilibrate the initial loads first.",
    "外边界默认条件": "Default outer boundary condition",
    "沿用原约束（反射）": "Existing constraints (reflecting)",
    "自由面（反射）": "Free surface (reflecting)",
    "吸收（近似无反射）": "Absorbing (approximate)",
    "固定边界（反射）": "Fixed boundary (reflecting)",
    "随全局设置": "Use global setting",
    "逐条边界覆盖": "Individual boundary overrides",
    "按几何边界编号设置。炮孔壁始终由压力脉冲控制，内部材料界面不受此设置影响。吸收条件会释放该边上原有的固定约束；交角处固定条件优先。": "Set by geometry boundary ID. Cavity walls retain pulse loading; internal material interfaces are unchanged. Absorbing boundaries release existing fixities on that edge; fixed overrides take precedence at corners.",
    "半正弦孔壁压力，可叠加外载荷与围压。结果按帧压缩保存，浏览器按需读取。损伤带表示裂纹，不包含碎块接触、压碎或炸药反应。": "Half-sine cavity pressure with external loads and confinement. Compressed frames are loaded on demand. Cracks are damage bands; fragment contact, crushing and explosive reactions are excluded.",
    "取消爆破计算": "Cancel blast calculation",
    "导出完整爆破结果（压缩）": "Export full blast history (compressed)",
    "导出爆破表格与云图（ZIP）": "Export blast tables and contours (ZIP)",
    "包含全部保存帧的 CSV 数据及当前帧的 SVG 云图，解压后打开 index.html 查看。": "Includes CSV data for all saved frames and SVG contours for the selected frame. Extract and open index.html.",
    "结果导出": "Export results",
    "导出表格与云图（ZIP）": "Export tables and contours (ZIP)",
    "导出当前类型云图（PNG）": "Export current contour type (PNG)",
    "CSV 可用 Excel / WPS 打开；SVG 可直接查看和引用。PNG 包含当前类型的各分量云图。": "Open CSV in Excel / WPS and view or reuse SVG directly. PNG includes the components of the current contour type.",
    "请先完成计算或读取结果。": "Run a calculation or load results first.",
    "正在生成结果表格与云图…": "Generating result tables and contours…",
    "结果包已生成，解压后打开 index.html 查看表格和云图。": "Result archive generated. Extract and open index.html to view tables and contours.",
    "云图图片转换失败。": "Contour image conversion failed.",
    "PNG 云图已导出（2400 × 1500，含单位、色标与帧时间）。": "PNG contours exported (2400 × 1500, including units, color scales and frame time).",
    "爆破扰动等效应力（统一色标）": "Blast-induced equivalent stress (fixed scale)",
    "显示 TNT 爆源示意": "Show TNT source illustration",
    "TNT 图标表示炮孔内爆源，装药外形为示意；压力仍由上面的脉冲参数给定。": "The TNT icon marks the cavity source and illustrates its appearance. Pressure is prescribed by the pulse settings above.",
    "TNT 爆破可视化": "TNT blast visualization",
    "待起爆": "Before pulse",
    "压力脉冲": "Pressure pulse",
    "脉冲结束": "After pulse",
    "孔壁压力时程": "Cavity pressure history",
    "孔壁压力时程与当前时刻": "Cavity pressure history and current time",
    "装药与起爆示意，非 TNT 爆轰本构。": "Source and pulse illustration; no TNT detonation constitutive model.",
    "显示应力响应边界": "Show stress response boundary",
    "青色线：应力超过全历程峰值 3% 的响应边界；深色网格：损伤 d ≥ 0.8。": "Cyan: boundary of stress response above 3% of the history peak. Dark mesh: damage d ≥ 0.8.",
    "青色线：扰动应力超过全历程峰值 3% 的响应边界；深色网格：损伤 d ≥ 0.8。": "Cyan: boundary of stress perturbation above 3% of its history peak. Dark mesh: damage d ≥ 0.8.",
    "等效应力（全历程统一色标）": "Equivalent stress (fixed history scale)",
    "青色线：应力响应边界；深色网格：高损伤单元。": "Cyan: stress response boundary. Dark mesh: highly damaged cells.",
    "爆破瞬态分析": "Transient Blast Analysis",
    "二维平面应力，坐标单位须为 m，厚度为 1 m。先画圆形炮孔并设为外部空气，给实体材料填写密度和抗拉强度。孔壁至少 6 条网格边。": "2D plane stress, coordinates in meters, thickness 1 m. Create a circular air cavity and assign density and tensile strength to the solid. Use at least 6 mesh edges on the cavity wall.",
    "炮孔中心 X (m)": "Cavity center X (m)",
    "炮孔中心 Y (m)": "Cavity center Y (m)",
    "炮孔半径 (m)": "Cavity radius (m)",
    "峰值压力 (MPa)": "Peak pressure (MPa)",
    "脉冲时长 (ms)": "Pulse duration (ms)",
    "模拟时长 (ms)": "Simulation duration (ms)",
    "时间步 (μs，0 自动)": "Time step (μs, 0 = auto)",
    "质量阻尼 (1/s)": "Mass damping (1/s)",
    "断裂能 Gf (J/m²)": "Fracture energy Gf (J/m²)",
    "保存帧数": "Saved frames",
    "启用拉伸损伤": "Enable tensile damage",
    "半正弦孔壁压力；从静止开始，需移除原有外载荷。使用当前普通网格，独立 CPU 动力求解。损伤带表示裂纹，不包含碎块接触、压碎或炸药反应。": "Half-sine cavity pressure, starting from rest. Remove existing external loads. Uses the current ordinary mesh and a CPU dynamics solver. Cracks are represented by damage bands; fragment contact, crushing and explosive reactions are excluded.",
    "运行爆破模拟": "Run blast simulation",
    "爆破帧请查看应力和损伤；静力安全校核不适用。": "Use stress and damage for blast frames; static safety checks do not apply.",
    "损伤云图": "Damage contour",
    "爆破时间历程": "Blast time history",
    "播放 / 暂停": "Play / Pause",
    "导出爆破结果 JSON": "Export blast history JSON",
    "损伤 d：0 完好，1 完全损伤。应力与应变云图显示当前帧；损伤带不代表已经张开的离散裂缝。": "Damage d: 0 = intact, 1 = fully damaged. Stress and strain contours show the current frame. A damage band does not represent an open discrete crack.",
    "爆破时间帧": "Blast time frame",
    "损伤 d（0–1）": "Damage d (0–1)",
    "正在运行爆破模拟…": "Running blast simulation…",
    "变形倍数": "Deformation Scale",
    "推荐倍数": "Suggested Scale",
    "编辑与视图": "Edit and View",
    "↶ 撤回上一步": "↶ Undo",
    "撤回上一步 (Ctrl+Z)": "Undo (Ctrl+Z)",
    "草稿（虚线）": "Construction (dashed)",
    "草稿支持全部曲线与规则图形；自动标记交点，不划分区域。": "Construction supports all curves and regular shapes. Intersections are marked without dividing regions.",
    "转为草稿": "Make Construction",
    "转为真实几何": "Make Real Geometry",
    "取线段等分点": "Create Division Points",
    "线段等分": "Divide Line Segment",
    "二等分": "2 Parts",
    "三等分": "3 Parts",
    "四等分": "4 Parts",
    "五等分": "5 Parts",
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
    "自适应安全节点上限": "Adaptive safety node limit",
    "自适应安全节点上限必须是 100–1000000 的整数。": "The adaptive safety node limit must be an integer from 100 to 1000000.",
    "基础网格超过自适应安全节点上限，请提高该上限。": "The initial mesh exceeds the adaptive safety node limit; increase this limit.",
    "自适应候选种子超过节点预算。": "The adaptive seed candidate exceeds the node budget.",
    "达到自适应安全节点上限": "Adaptive safety node limit reached",
    "达到奇点保护限制": "Singularity protection limit reached",
    "误差下降停滞，已保留最后成功结果": "Error reduction stalled; the last successful result was retained",
    "加密失败，已保留最后成功结果": "Refinement failed; the last successful result was retained",
    "自适应参数无效：细化轮数 0–100，目标相对误差 0–1。": "Invalid adaptive settings: 0–100 refinement steps and relative error between 0 and 1.",
    "0.02 表示 2%。自适应模式使用独立的安全节点上限，达到目标误差、细化轮数或保护限制时停止。": "0.02 means 2%. Adaptive mode uses its own safety node limit and stops at the target error, refinement count, or protection limit.",
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

  const BLAST_ERROR_TEXT = Object.freeze({
    "Rebuild the native core for the selected gas EOS.": "请重新编译计算核心以使用所选气体状态方程。",
    "Invalid nonideal gas constitutive parameters.": "非理想气体本构参数无效。",
    "Selected gas EOS requires positive covolume.": "所选气体 EOS 需要正余容积。",
    "Selected gas EOS requires positive pressure offset.": "所选气体 EOS 需要正压力偏移。",
    "Van der Waals requires positive attraction.": "van der Waals 需要正吸引系数。",
    "Gas density/internal energy must be positive and covolume times density below one.": "气体密度和内能必须为正，余容积与密度乘积必须小于一。",
    "Van der Waals requires a stable single phase above the critical temperature.": "van der Waals 需要高于临界温度的稳定单相状态。",
    "Gas internal energy must exceed its energy reference.": "气体内能必须高于参考能量。",
    "Nonideal gas EOS left the positive-pressure or hyperbolic domain.": "非理想气体 EOS 超出正压力或双曲区域。",
    "Nonideal gases currently require sealed axial ends.": "非理想气体目前要求轴向两端封堵。",
    "Rebuild the native core for the selected solid model.": "请重新编译计算核心以使用所选固体本构。",
    "Unsupported solid material card version.": "固体材料卡版本不受支持。",
    "Malformed solid material parameters.": "固体本构参数格式错误。",
    "Incomplete solid material parameters.": "固体本构参数不完整。",
    "Invalid solid constitutive parameters or nonpositive elastic compliance.": "固体本构参数无效或弹性柔度非正定。",
    "Hyperelastic materials require finite deformation and plane strain.": "超弹性材料需要有限变形和平面应变。",
    "Maxwell, MCC and orthotropic materials currently require small deformation.": "Maxwell、MCC 和正交各向异性材料目前需要小变形。",
    "Solid plastic return could not bracket a root.": "固体塑性返回无法括定根。",
    "MC principal stress decomposition failed.": "MC 主应力分解失败。",
    "MC active-surface return did not converge; reduce the strain increment.": "MC 多屈服面返回未收敛，请减小应变增量。",
    "MCC requires positive effective pressure; tensile states are unsupported.": "MCC 需要正有效压力，不支持拉伸状态。",
    "HJC volume collapsed; reduce the strain increment.": "HJC 体积塌缩，请减小应变增量。",
    "Hyperelastic deformation gradient is inverted or collapsed.": "超弹性变形梯度已经倒置或塌缩。",
    "Hyperelastic stretch is nonpositive.": "超弹性伸长比非正。",
    "Solid update requires a finite strain increment and positive time step.": "固体更新需要有限应变增量和正时间步。",
    "Hyperelastic updates require the total deformation gradient.": "超弹性更新需要总变形梯度。",
    "Non-finite solid state; check parameters and time step.": "固体状态出现非有限值，请检查参数和时间步。",
    "MCC requires positive initial effective confinement.": "MCC 需要正初始有效围压。",
    "Hyperelastic/HJC initial preload requires nonlinear static initialization; choose sudden loading.": "超弹性或 HJC 初始预载需要非线性静力初始化，请选择突然加载。",
    "Initial equilibrium exceeds solid yield; nonlinear static initialization is required.": "初始平衡已超过固体屈服面，需要非线性静力初始化。",
    "Invalid axial vent geometry or opening time.": "轴向端部几何或开启时间无效。",
    "Axial discharge requires an isentropic exponent greater than one.": "轴向泄流需要大于一的等熵指数。",
    "Axial discharge left the positive mass/energy domain.": "轴向泄流超出正质量或正能量范围。",

    "Strong gas expansion requires positive isentropic exponents.": "强稀疏气流需要大于一的局部等熵指数。",
    "Physical vacuum formed in gas expansion; a vacuum-capable fluid method is required.": "气体膨胀形成了物理真空，需要支持真空的流体方法。",
    "Nonlinear gas contact pressure could not be bracketed.": "无法括定非线性气体接触压力。",
    "Finite deformation currently requires plane strain.": "有限变形当前仅支持平面应变，请先切换二维假设。",
    "Invalid rock or fracture-storage selection.": "岩石本构或裂隙储气设置无效。",
    "Cannot read rock material cards.": "无法读取岩石本构参数卡。",
    "Malformed rock material card.": "岩石本构参数卡格式错误。",
    "Invalid/duplicate rock material card.": "岩石本构参数卡编号无效或重复。",
    "Selected rock model requires a material card.": "所选岩石本构需要完整的材料参数卡。",
    "Invalid JH2 parameters.": "JH2 参数无效，请检查材料卡。",
    "JH2 compression EOS is not hyperbolic.": "JH2 压缩状态方程切线非正，请检查 K1/K2/K3。",
    "DP requires compression/tension strengths and valid friction/dilation angles.": "DP 需要单轴抗压、抗拉强度以及有效摩擦角和剪胀角。",
    "Finite-deformation mesh inverted/collapsed; this case requires remeshing or a particle solver.": "有限变形网格已经倒置或塌缩，此工况需要重网格或粒子求解器。",
    "Invalid finite-deformation stretch.": "有限变形伸长张量无效。",
    "Initial equilibrium exceeds JH2 strength; nonlinear static initialization is required.": "初始平衡已超过 JH2 强度，需要非线性静力初始化。",
    "Initial equilibrium exceeds DP strength; nonlinear static initialization is required.": "初始平衡已超过 DP 强度，需要非线性静力初始化。",
    "Finite-deformation step limit reached; severely distorted mesh requires remeshing.": "有限变形达到步数上限，严重畸变网格需要重网格。",
    "Finite-deformation CFL step collapsed; use remeshing or a particle solver.": "有限变形稳定步长已塌缩，需要重网格或粒子求解器。",
    "Rock volume collapsed; refine mesh/time step or use a particle solver.": "岩石体积已塌缩，请细化网格、减小时间步或使用粒子求解器。",
    "Rock principal stress decomposition failed.": "岩石主应力分解失败。",
    "Tensile damage needs measured ft and a compatible Gf/mesh.": "拉伸损伤需要实测抗拉强度及兼容的断裂能和网格。",
    "Non-finite rock stress; check constitutive parameters and time step.": "岩石应力出现非有限值，请检查本构参数及时间步。",
    "Rock strain increment too large; reduce time step.": "岩石应变增量过大，请减小时间步。",
    "Rock plane-stress return did not converge; reduce time step or use plane strain.": "岩石平面应力返回未收敛，请减小时间步或采用平面应变。",
    "Rebuild the native core for the selected rock model.": "请重新编译计算核心以使用所选岩石本构。",
    "Unsupported blast cell layout.": "不支持此爆破单元数据布局。",
    "Download closed.": "下载连接已关闭。",
    "Parameter library changed in another window. Reload before saving.": "参数库已在其他窗口修改，请重新读取后保存。",
    "Failed to fetch": "无法连接程序服务，请检查服务和网络。",
    "Failed to load blast frame.": "无法读取爆破帧，请重新计算。",
    "Non-finite blast frame header.": "爆破帧包含非有限值。",
    "Incomplete blast frame.": "爆破帧数据不完整。",
    "Unsupported blast frame scalar count.": "爆破帧标量布局不受支持。",
    "Invalid blast frame dimensions.": "爆破帧维度无效。",
    "Blast frame exceeds 256 MiB.": "爆破帧超过 256 MiB。",

  "Blast simulation failed.": "爆破计算失败。",
  "Blast calculation cancelled.": "爆破计算已取消。",
  "Charge radius exceeds the cavity radius.": "装药半径大于实际炮孔半径，请减小装药半径。",
  "Invalid blast radius, pressure, times, damage or frame count.": "炮孔、压力、时间、损伤或帧数参数无效。",
  "Invalid blast boundary, confinement or time limit.": "边界、围压或计算时限参数无效。",
  "Invalid gas source or EOS mode.": "气体来源或状态方程类型无效。",
  "Invalid gas source or product EOS mode.": "气体来源或产物状态方程类型无效。",
  "Invalid gas/products parameters; JWL requires calibrated expansion coefficients.": "气体或产物参数无效；JWL 模型需要标定的膨胀系数。",
  "Blast radius/times must be positive, pressure nonnegative, pulse <= duration.": "炮孔半径和时间必须为正、压力非负，脉冲时长不能超过模拟时长。",
  "Gas cells must be an integer from 16 to 2048.": "径向气体单元数必须是 16 到 2048 的整数。",
  "Equivalent CJ model requires positive detonation velocity and energy.": "等效 CJ 模型需要正的爆速和能量。",
  "Invalid blast integration/boundary/load settings.": "时间积分、边界或载荷参数无效。",
  "Blast requires model nodes and elements.": "爆破计算需要有效的节点和单元。",
  "Blast requires a triangular mesh.": "爆破计算需要三角形网格。",
  "Blast elements require positive area, density, E and -1 < nu < 0.5.": "单元面积、密度、弹性模量必须为正，泊松比必须在 -1 和 0.5 之间。",
  "Blast center must lie in an explicitly meshed circular cavity.": "爆源中心必须位于网格中明确建立的圆形炮孔内。",
  "Fracture needs positive tensile strength and Gf/h > ft^2/(2E); refine mesh or check material/Gf.": "拉伸损伤需要正的抗拉强度且 Gf/h > ft²/(2E)；请细化网格或检查材料与断裂能。",
  "Requested blast dt exceeds stability or pressure-resolution limit; use dt=0.": "时间步超过稳定性或压力分辨率限制；请将时间步设为 0 自动计算。",
  "Blast needs over 20 million steps; check tiny elements or simulation duration.": "计算步数超过两千万；请检查过小单元或模拟时长。",
  "Blast solution diverged; check mesh/material/time step.": "爆破计算发散；请检查网格、材料或时间步。",
  "Initial elastic equilibrium already exceeds tensile strength. Pre-damaged static equilibrium is not supported; check confinement/material or disable damage.": "初始弹性平衡状态已超过抗拉强度，当前不支持预损伤静力平衡；请检查围压、材料或损伤设置。",
  "Initial stress equilibrium stiffness is singular; check constraints and disconnected mesh.": "初始应力平衡刚度矩阵奇异；请检查约束及不连通网格。",
  "Initial stress equilibrium solve failed.": "初始应力平衡求解失败。",
  "External loads cannot equilibrate without rigid-body reactions. Add physical supports, balance forces/moments, or select sudden loading.": "外载荷无法在无刚体反力条件下平衡；请添加实际支撑、平衡合力与力矩或选择突然加载。",
  "No closed circular cavity with at least 6 boundary edges matches blast center/radius.": "未找到与爆源中心和半径匹配、且至少含 6 条边的闭合圆孔。",
  "Blast cavity boundary must be a complete closed loop.": "炮孔边界必须形成完整闭环。",
  "Blast model has no movable degrees of freedom.": "模型没有可运动的自由度。",
  "Mean cavity area collapsed in gas coupling.": "气固耦合中的平均炮孔面积已塌缩。",
  "Nonpositive gas density/internal energy.": "气体密度或比内能非正。",
  "Gas mesh inverted or internal energy became nonpositive.": "气体网格翻转或比内能变为非正。",
  "Gas Riemann state reached vacuum/nonpositive pressure.": "气体黎曼状态达到真空或非正压力。",
  "Gas EOS left its positive-pressure/hyperbolic domain; check material parameters.": "气体状态超出状态方程的正压或双曲区域；请检查材料参数。",
  "Conservative gas rezoning left the physical EOS domain.": "气体保守重映射超出状态方程的物理范围。",
  "Gas timestep collapsed; check EOS or severe cavity collapse.": "气体时间步趋于零；请检查状态方程或炮孔严重塌缩。",
  "Gas step repeatedly left the physical state domain.": "气体子步反复超出物理状态范围。",
  "Invalid radial gas resolution/geometry.": "径向气体分辨率或几何参数无效。",
  "Charge must fit inside gas cavity.": "装药必须位于气体炮孔内部。",
  "Invalid products/JWL material parameters.": "产物或 JWL 材料参数无效。",
  "Invalid air material parameters.": "空气材料参数无效。",
  "Invalid gas advance target.": "气体推进目标无效。",
  "Two blast calculations are already running. Wait or cancel a run before starting another.": "已有两个爆破计算正在运行，请等待或取消其中一个。",
  "Blast history expired. Run the simulation again.": "爆破历史已过期，请重新计算。",
  "Blast history expired or frame does not exist. Run the simulation again.": "爆破历史已过期或帧不存在，请重新计算。",
  "Unsupported blast stream; rebuild the C++ core.": "爆破数据流版本不支持，请重新编译计算核心。",
  "Native core does not support gas dynamics; rebuild and restart the program.": "计算核心不支持气体动力学，请重新编译并重启程序。",
  "Native blast solver failed.": "爆破计算核心执行失败。",
  "Invalid explosive ID/name.": "炸药条目编号或名称无效，请填写名称。",
  "Invalid gas ID/name.": "气体条目编号或名称无效，请填写名称。",
  "Invalid CJ pressure.": "参考 CJ 压力必须为正或留空。",
  "Invalid explosive record.": "炸药条目无效。",
  "Invalid gas record.": "气体条目无效。",
  "Invalid explosive library.": "炸药库数据无效。",
  "Invalid gas library.": "气体库数据无效。",
  "Duplicate explosive IDs.": "炸药库存在重复编号。",
  "Duplicate gas IDs.": "气体库存在重复编号。",
  "Invalid explosive library revision.": "炸药库版本号无效。",
  "All blast history slots are in use.": "爆破历史存储槽位已全部占用。",
  "Native blast stream ended before all frames arrived.": "爆破数据流提前结束，部分帧未能接收。",
  "Unexpected trailing blast stream data.": "爆破数据流末尾存在异常数据。",
  "Invalid blast boundary edge.": "爆破边界边数据无效。",
  "Invalid blast metadata length.": "爆破元数据长度无效。",
  "Invalid blast stream dimensions.": "爆破数据流维度无效。",
  "Invalid blast frame summary.": "爆破帧摘要无效。",
  "Compressed blast history exceeds 4 GiB. Reduce saved frames or duration.": "压缩结果超过 4 GiB，请减少保存帧数或模拟时长。",
  "Use lazy:true for histories larger than 128 MiB.": "超过 128 MiB 的结果必须按帧读取。",
  "Duplicate blast node number.": "爆破网格存在重复节点编号。",
  "Blast mesh contains a nonmanifold edge.": "爆破网格存在非流形边。",
  "Cannot read blast boundary overrides.": "无法读取爆破边界覆盖设置。",
  "Invalid blast boundary override.": "爆破边界覆盖设置无效。",
  "Boundary override must reference a true exterior mesh edge.": "边界覆盖设置必须引用实际外边界网格边。",
  "Duplicate blast boundary override.": "爆破边界覆盖设置重复。",
  "Malformed blast boundary override file.": "爆破边界覆盖文件格式无效。",
  "Selected pressure boundary is not a cavity wall.": "所选压力边界不是炮孔壁。",
  "Unconnected node or invalid blast mass/stiffness.": "存在不连通节点或无效质量、刚度。",
  "Failed writing streamed blast frame.": "写入爆破帧数据流失败。",
  "JWL requires user-supplied expansion coefficients; use ideal products for verification.": "JWL 需要填写膨胀系数；验证时可使用理想产物模型。",
  "A single blast frame exceeds 256 MiB; partition the model.": "单个爆破帧超过 256 MiB，请拆分模型。"
});

  const BLAST_ERROR_RULES = [
    [/^Invalid blast setting: (.+)$/u,m=>`爆破参数无效：${m[1]}`],
    [/^Invalid (explosive|gas) parameter: (.+)$/u,m=>`${m[1]==="gas" ? "气体" : "炸药"}参数无效：${m[2]}`],
    [/^Blast calculation exceeded (.+) seconds\.$/u,m=>`爆破计算超过 ${m[1]} 秒。`],
    [/^Damage requires positive tensile strength \(MPa in the material library\): (.+)\.$/u,m=>`缺少单轴抗拉强度：${m[1]}。请在“时间积分与损伤”中填写，单位 MPa。`],
    [/^Damage mesh\/energy mismatch: Gf must exceed (.+) J\/m\^2; current (.+)\. Refine the mesh or use a calibrated Gf\. Critical element (.+)\.$/u,m=>`损伤网格与断裂能不匹配：当前 Gf = ${m[2]} J/m²；材料 / E${m[3]} 要求 Gf > ${m[1]} J/m²。请细化网格或检查已标定的强度、断裂能。`]
  ];

  const DYNAMIC_RULES = [
    [/^(爆轰产物|间隙气体|气体耦合)：(.+)$/u,m=>`${({'爆轰产物':'Products','间隙气体':'Gap gas','气体耦合':'Gas coupling'})[m[1]]}: ${translateEnglishText(m[2])}`],
    [/^(.+) · (.+)：(.+)$/u,m=>`${m[1]} · ${translateEnglishText(m[2])}: ${translateEnglishText(m[3])}`],
    [/^非弹性耗能 = (.+) J \/ 连通裂隙体积 = (.+) m³\/m \/ 裂隙储气功 = (.+) J$/u,m=>`Inelastic dissipation = ${m[1]} J / connected fracture volume = ${m[2]} m³/m / fracture storage work = ${m[3]} J`],
    [/^(.+) 本构$/u,m=>`${m[1]} constitutive model`],
    [/^Prony (g[1-4])（未用填 0）$/u,m=>`Prony ${m[1]} (0 if unused)`],
    [/^Prony (τ[1-4]) \(ms，未用填 0\)$/u,m=>`Prony ${m[1]} (ms; 0 if unused)`],
    [/^(.+) · ((?:J2|Johnson|Mohr|广义|Neo|Modified|DP-Cap|正交|Mooney|HJC).+)$/u,m=>`${translateEnglishText(m[1])} · ${translateEnglishText(m[2])}`],
    [/^(.+): (.+) — (.+)$/u,m=>`${m[1]}: ${translateEnglishText(m[2])} — ${translateEnglishText(m[3])}`],
    [/^塑性耗能 = (.+) J \/ 连通裂隙体积 = (.+) m³\/m \/ 裂隙储气功 = (.+) J$/u,m=>`Plastic dissipation = ${m[1]} J / connected fracture volume = ${m[2]} m³/m / fracture storage work = ${m[3]} J`],
    [/^实际步数 = (.+) \/ 最小 J = (.+) \/ 稀疏波返回 = (.+)$/u,m=>`Actual steps = ${m[1]} / minimum J = ${m[2]} / rarefaction fallbacks = ${m[3]}`],
    [/^完成 \/ (\d+) (?:步|steps) \/ 自适应 Δt ≤ (.+)$/u,m=>`Completed / ${m[1]} steps / adaptive Δt ≤ ${m[2]}`],
    [/^轴向流出能量 = (.+) J \/ 流出质量 = (.+) kg\/m$/u,m=>`Axial discharge energy = ${m[1]} J / mass = ${m[2]} kg/m`],
    [/^(正在准备网格|正在准备模型与初始平衡|正在求解|正在保存结果|计算完成) · (.+)$/u, match => {
      const phase={"正在准备网格":"Preparing mesh","正在准备模型与初始平衡":"Preparing model and initial equilibrium","正在求解":"Solving","正在保存结果":"Saving results","计算完成":"Complete"}[match[1]];
      return `${phase} · ${match[2].replace(/正在估算剩余时间…/gu,"Estimating remaining time…").replace(/预计剩余/gu,"Estimated remaining").replace(/已用/gu,"Elapsed").replace(/步/gu,"steps").replace(/分/gu,"min").replace(/秒/gu,"s")}`;
    }],
    [/^损伤网格细化：(.+) 轮 \/ (.+) 节点 \/ (.+) 单元$/u,m=>`Damage mesh refinement: ${m[1]} rounds / ${m[2]} nodes / ${m[3]} elements`],
    [/^损伤网格已兼容：(.+) 节点 \/ (.+) 单元；保留输入的强度与断裂能。$/u,m=>`Damage mesh compatible: ${m[1]} nodes / ${m[2]} elements; input strength and fracture energy retained.`],
    [/^损伤网格细化预计超过资源上限（(.+) 节点 \/ (.+) 单元）。请核对单轴抗拉强度、模型单位与断裂能，或缩小模型范围。$/u,m=>`Damage mesh refinement would exceed the resource limit (${m[1]} nodes / ${m[2]} elements). Check uniaxial tensile strength, model units and fracture energy, or reduce the model size.`],
    [/^损伤网格与断裂能不匹配：当前 Gf = (.+?) J\/m²；(.+?) \/ E(.+?) 要求 Gf > (.+?) J\/m²。请细化网格或检查已标定的强度、断裂能。$/u,m=>`Damage mesh/energy mismatch: current Gf = ${m[1]} J/m²; ${translateEnglishText(m[2])} / E${m[3]} requires Gf > ${m[4]} J/m². Refine the mesh or check calibrated strength and fracture energy.`],
    [/^缺少单轴抗拉强度：(.+)。请在“时间积分与损伤”中填写，单位 MPa。$/u,m=>`Missing uniaxial tensile strength: ${m[1].split(/[、,]/u).map(translateEnglishText).join(", ")}. Enter it under Time Integration and Damage in MPa.`],
    [/^(.+)：请填写大于 0 的单轴抗拉强度 \(MPa\)。$/u,m=>`${translateEnglishText(m[1])}: Enter a positive uniaxial tensile strength (MPa).`],
    [/^(.+) — 单轴抗拉强度 \(MPa\)$/u,m=>`${translateEnglishText(m[1])} — Uniaxial tensile strength (MPa)`],
    [/^完成 \/ (\d+) (?:步|steps) \/ Δt = (.+)$/u,m=>`Completed / ${m[1]} steps / Δt = ${m[2]}`],
    [/^气体 U = (.+)$/u,m=>`Gas U = ${m[1]}`],
    [/^爆破计算失败：([\s\S]+)$/u,m=>`Blast simulation failed: ${translateEnglishText(m[1])}`],
    [/^爆破计算超过 (.+) 秒。$/u,m=>`Blast calculation exceeded ${m[1]} seconds.`],
    [/^爆破参数无效：(.+)$/u,m=>`Invalid blast setting: ${m[1]}`],
    [/^(气体|炸药)参数无效：(.+)$/u,m=>`Invalid ${m[1]==="气体" ? "gas" : "explosive"} parameter: ${m[2]}`],
    [/^径向空气间隙：(.+) m$/u, match => `Radial air gap: ${match[1]} m`],
    [/^已识别实际孔壁；装药半径保持不变。孔壁边数：(\d+)$/u, match => `Actual wall identified; charge radius preserved. Wall edges: ${match[1]}`],
    [/^(当前参数：|最近圆孔：|已从当前网格填入炮孔：)(.+)$/u, match => `${ENGLISH_TEXT[match[1]]}${match[2].replace("孔壁边数", "Wall edges")}`],
    [/^炮孔与网格匹配。孔壁边数：(\d+)$/u, match => `Cavity matches the mesh. Wall edges: ${match[1]}`],
    [/^x = (.+) \/ 孔壁边数 = (\d+)$/u, match => `x = ${match[1]} / Wall edges = ${match[2]}`],
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
    [/^(.+) (几何节点|边界)（(草稿|真实)）$/u, (match) => `${match[1]} ${match[2] === "几何节点" ? "Geometry Node" : "Boundary"} (${match[3] === "草稿" ? "construction" : "real"})`],
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

  function sourceMessage(value) {
    const text = String(value ?? "");
    const prefix = text.match(/^Blast simulation failed:\s*([\s\S]+)$/u);
    if (prefix) return `爆破计算失败：${sourceMessage(prefix[1])}`;
    for (const [pattern, replacement] of BLAST_ERROR_RULES) {
      const match = text.match(pattern);if (match) return replacement(match);
    }
    return BLAST_ERROR_TEXT[text] || text;
  }
  function uiText(value) {
    const source = sourceMessage(value);
    return activeLanguage === "en" ? translateEnglishText(source) : source;
  }
  // Reading labels for a new editor must use their source, not the currently displayed translation.
  function sourceText(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return sourceTextByNode.get(node) || node.data;
    return node.childNodes ? Array.from(node.childNodes, sourceText).join("") : node.textContent || "";
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
    if (knownSource && current !== knownSource && current === translateEnglishText(knownSource)) {
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
    if (knownSource && current !== knownSource && current === translateEnglishText(knownSource)) {
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
    if (knownSource && current !== knownSource && current === translateEnglishText(knownSource)) {
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

  const OBSERVER_OPTIONS = {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:TRANSLATABLE_ATTRIBUTES};
  function observeDynamicInterfaceText() {
    if (typeof MutationObserver !== "function" || mutationObserver) return;
    mutationObserver = new MutationObserver((records) => {
      mutationObserver.disconnect();
      try {
        for (const record of records) {
          if (record.type === "characterData") {
            translateTextNode(record.target);
          } else if (record.type === "attributes") {
            translateAttribute(record.target, record.attributeName);
          } else {
            record.addedNodes.forEach((node) => translateTree(node));
          }
        }
      } finally {
        mutationObserver.observe(document.documentElement, OBSERVER_OPTIONS);
      }
    });
    mutationObserver.observe(document.documentElement, OBSERVER_OPTIONS);
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
    const page = document.querySelector?.('.page-view:not([hidden])')?.dataset.page || "home";
    const refreshFunctions = {
      home:["updatePanel","render"], calculation:["updateCalculationPanel","renderCalculationView"],
      results:["renderResultView"], "blast-results":["renderResultView"],
      materials:["renderMaterialLibrary"], blast:["renderBlastSetup"], "blast-library":[]
    }[page] || [];
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
    mutationObserver?.disconnect();
    try {
      translateTree(document.documentElement);
      const selector = document.getElementById("interfaceLanguage");
      if (selector) selector.value = nextLanguage;
      if (options.refresh !== false) refreshInterfaceAfterLanguageChange();
      translateTree(document.documentElement);
    } finally {
      mutationObserver?.observe(document.documentElement, OBSERVER_OPTIONS);
    }
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
    sourceMessage,
    sourceText,
    translateEnglish: translateEnglishText,
  };
  window.uiText = uiText;

  installLocalizedDialogs();
  installLocalizedCanvasText();
  setupLanguageSelector();
  setLanguage(activeLanguage, { persist: false, refresh: false });
  observeDynamicInterfaceText();
})();
