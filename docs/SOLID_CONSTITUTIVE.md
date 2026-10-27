# 爆破模块：固体本构

本文描述固体材料扩展。后续的气体 EOS 扩展和直接显示在爆破设置上的条件冲突检查见 [气体本构与界面限制](GAS_CONSTITUTIVE.md)。基础静力模块仍使用原来的线弹性材料；这里的选择作用于爆破瞬态模块。模型名称、字段顺序与材料卡归一化在 `blast-materials.js`，C++ 更新在 `TensoraCore/SolidConstitutive.h`。

## 选择与保存

在 **爆破设置 → 固体本构与破坏后的气体响应** 选择默认模型。每种已分配到结构区域的材料还可以单独覆盖模型，同一网格支持混合材料。填写后点击 **保存各材料本构参数**，也可由运行流程保存。参数写入项目材料库和区域材料快照，模型 JSON 保留这些卡；模型切换保留同次编辑的各组草稿。新模型字段不使用未经标定的自动材料预设。`tests/helpers/solid-cards.js` 仅为合成数值验证数据，不能作为实际金属、岩土、橡胶或混凝土参数。

界面使用字段标签所示的 MPa、GPa、ms、K 等单位；JSON 和原生求解器使用 Pa、s、K、kg/m³、J/kg/K。基本材料库中的 E 使用 GPa，强度使用 MPa，导出到求解器时统一换算。MC 的拉伸截断和 HJC 的静水拉伸强度均在各自卡内，不能直接替代裂带模型的单轴抗拉强度。

保持原模型 ID 0–3 的含义与旧 JSON 兼容：0 裂带拉伸损伤，1 线弹性，2 DP + 拉伸损伤，3 JH2。新 ID 如下。

| ID | 模型 | 已实现行为 | 运动学/注意事项 |
|---|---|---|---|
| 4 | J2 / Von Mises | 三维径向返回、线性等向硬化、弹性卸载 | 不含断裂 |
| 5 | Johnson–Cook | 塑性应变率强化、幂硬化、热软化、绝热升温 | 不含 JC 断裂、热传导或热膨胀 |
| 6 | Mohr–Coulomb | 真正主应力屈服面、非关联剪胀、棱边/顶点返回、拉伸截断 | 不以 DP 锥面代替 MC；不含强度软化 |
| 7 | 广义 Maxwell / Prony | 最多 4 个剪切支路、指数积分、黏性耗能 | 小变形；体积不松弛 |
| 8 | Neo-Hookean | 可压缩、等容剪切与体积罚能 | 有限变形、平面应变 |
| 9 | Modified Cam-Clay | 常弹性版本、关联流动、指数预固结硬化/软化 | 小变形，正初始有效围压；不求孔隙水 |
| 10 | DP-Cap | DP 剪切面、椭圆压缩帽盖、线性不可逆压实硬化 | C⁰ 连续；没有商业模型的光滑过渡曲面或查表硬化 |
| 11 | J2 / Perzyna | 隐式过应力积分、等向硬化 | 不含断裂 |
| 12 | 正交各向异性弹性 | 9 个独立弹性常数、面内方向、三维柔度与平面应力消元 | 小变形；正定性检查 |
| 13 | Mooney–Rivlin | 两参数等容能与可压缩体积能 | 有限变形、平面应变 |
| 14 | HJC 连续压实变体 | 压力/应变率强化、剪切损伤、三段压实、不可逆孔隙压缩、拉伸截断 | 不含侵蚀；EOS 变体定义见下文 |

**损伤开关仅控制损伤演化**，不关闭 J2/JC/MC/MCC/Cap/Perzyna 的屈服、Maxwell 松弛或 HJC 体积压实。不含损伤的模型其 d 保持 0；MC 拉伸截断属于塑性，不是裂带断裂能软化。Gf 网格兼容细化仍只针对模型 0、2。

## 方程和参数约定

统一取拉应力为正，`p = −tr(σ)/3` 为正压缩，`q = sqrt(3/2 s:s)`。`ep` 为累计等效偏塑性应变；总应变输入的面内第三项为工程剪应变 γxy，内部张量 εxy=γxy/2。一般材料更新对大增量作材料子步；平面应力通过对旧状态的独立试算求 σzz=0，迭代不会重复累加历史。

### J2 与 Perzyna

J2 屈服函数 `q − (Y0 + H ep)`，`Δep = max(0, (qtrial − Yold)/(3G+H))`。保留弹性体积响应，偏应力径向返回。要求 Y0>0、H≥0。硬化能 `H ep²/2` 与非弹性耗能分别记账。

Perzyna 使用 `Δep = (dt/τ) <(qtrial−3GΔep−Y0−H(ep+Δep))/Y0>ⁿ` 的隐式标量根。τ 单位 s，n>0。固定 dt 减小 τ 时趋近率无关 J2；τ 本身是需要标定的材料时间尺度。

### Johnson–Cook

`Y = (A+B epⁿ) [1+C ln(max(1, epdot/rate0))] [1−T*ᵐ]`，其中 `T*=clamp((T−Tref)/(Tmelt−Tref),0,1)`。根中使用该子步的**塑性**应变率 `Δep/dt`，不使用总应变率代替。低于参考速率时不继续降低强度。

每个材料子步先按旧温度求返回，再由偏塑性功计算 `ΔT = χ ΔWp/(ρ cp)`；热耦合为子步显式，须作时间/材料步长敏感性检查。有限变形时将 Cauchy 功密度按当前体积换算到参考密度。ρ 取基本材料密度，不能从本构卡另行覆盖。需要 A>0、B≥0、n>0、C≥0、rate0>0、m>0、cp>0、0≤χ≤1、0<Tref≤Tinitial<Tmelt。

### Mohr–Coulomb

主应力取拉正，任意两主方向 a、b 的剪切面为 `(1+sinφ) σa − (1−sinφ) σb − 2c cosφ ≤ 0`；另有三个主方向的 `σa≤Tcut`。流动方向将 φ 换为 ψ，拉伸面采用关联流动。枚举最多 3 个同时活动面，解塑性乘子并检查所有面的可容许性，涵盖剪切棱边、锥顶及剪切/拉伸交点。c≥0，0≤ψ≤φ<89°；φ>0 时 `0≤Tcut≤c/tanφ`。

### Maxwell / Prony

基本 E、ν 对应**瞬时** `G0=E/[2(1+ν)]`，K 不松弛。`G(t)=G0 [1−Σgi+Σgi exp(−t/τi)]`。支路 `qdot_i + qi/τi = 2G0 gi edot_dev` 对每个恒应变率子步用解析指数积分；耗能用 `∫qi:qi/(2Giτi) dt` 的解析式。平衡弹簧和各支路弹性能分别求和。gi≥0，活动支路 τi>0，0<Σgi<1。未用支路的 g、τ 均填 0。

初始线弹性预平衡按瞬时刚度建立，支路初始应力与该瞬时状态一致，之后会发生真实应力松弛。若实验初态是长期松弛后的平衡状态，当前初始化不适用，不能将启动松弛误认为数值误差。

### Neo-Hookean 与 Mooney–Rivlin

两者使用**总变形梯度 F**，不会将累计小应变代入超弹性公式。`J=det F`，`bbar=J^(−2/3) F Fᵀ`，`I1bar=tr bbar`，`I2bar=[(tr bbar)²−tr(bbar²)]/2`。

Neo-Hookean：`W = G/2 (I1bar−3) + K/2 (J−1)²`。

Mooney–Rivlin：`W = C10(I1bar−3) + C01(I2bar−3) + K/2 (J−1)²`，初始 G=2(C10+C01)。采用 C10、C01≥0 且两者之和>0 的稳定参数子集。

`σ = [2 C10 dev(bbar)+2 C01 dev(I1bar bbar−bbar²)]/J + K(J−1)I`，Neo-Hookean 对应 C10=G/2、C01=0。通过 W 对 F 的数值导数、刚体转动和旋转客观性检查。显式质量/时间步及静态参考刚度使用卡内初始 G、K，不使用另填的基础 E、ν。近不可压 K/G 很大时，位移型 TRI3 会锁死、时间步也会变小；当前没有混合 u-p 单元。

### MCC 常弹性变体

本版明确使用基本材料给定的常 K、G；**不包含经典 MCC 的压力相关回弹刚度 `K=(1+e)p/κ`**。这是为适配现有弹性初始平衡而保留的常弹性 MCC 变体。

`f=q²+M² p(p−pc)`，关联流动；`pc_new = pc_old exp[v/(λ−κ) Δεv_plastic]`，压实塑性体积应变为正，`v=(1+e0) exp(trε−trε_initial)`。λ>κ>0、e0>0、pc>0。隐式求 p、q、pc，椭圆干侧允许 pc 软化，pc 不被错误地强制单调。只支持正有效压力；初始状态必须位于屈服面内，不会添加隐藏初始应力或孔隙水压力。

### DP-Cap 椭圆帽盖变体

`q ≤ d+tanβ p`（p≤pa），流动剪胀系数 tanψ；压缩帽盖为 `[(p−pa)/R]²+q² ≤ [d+tanβ pa]²`（p≥pa）。两面在 p=pa 处连续，但一般不是光滑相接。帽盖采用关联流动，隐式同时求返回及 `pa_new=pa_old+H max(Δεv_plastic,0)`。剪切导致的膨胀不回退已发生的压实硬化。剪切返回跨越接合点时返回接合棱线。d>0、pa>0、R>0、H≥0、0≤ψ≤β<80°。

### HJC 连续压实变体

采用 HJC 强度和破坏应变：压缩时 `Y=fc min(Smax, [A(1−d)+B(p/fc)^N] [1+C ln(max(1,rate/rate0))])`；拉伸压力下采用随 `(1+p/T)` 线性下降的黏聚项。`εf=max(εf_min,D1[max(0,(p+T)/fc)]^D2)`，损伤累积偏塑性和不可逆压实体积增量，残余摩擦强度保留。应变率取等效偏应变率。拉伸截断 `p≥−(1−d)T`，保存不可逆拉伸开度，因此静止的已截断状态不会重复产生损伤或耗能。

这里采用**显式定义的连续 EOS 变体**，不声称与 LS-DYNA MAT_111 每一条卸载/锁定约定完全一致。`μ=ρ/ρ0−1`；小变形模式由 `J≈1+trε` 得到 μ，有限变形使用实际 J。

- μ≤μc：`p=K0 μ`，`K0=pc/μc`。
- μc<μ≤μl：连接 `(μc,pc)` 与 `(μl,pl)` 的直线压实包络。
- μ>μl：`p=pl+K1 z+K2 z²+K3 z³`，`z=(μ−μl)/(1+μl)`。pl 偏移保证包络连续。
- 卸载刚度由历史最大压缩在 K0 与 K1 之间插值；保存历史最大压缩、不可逆压实与拉伸开度。μl 后不再增加孔隙压实，密实压缩按 EOS 处理。

要求 K1≥K0，压实段斜率在 0 和 K0 之间，K3≥0，且整个非负 z 范围 EOS 切线为正。材料库基础 E、ν 提供剪切模量；K0 替换初始体积刚度。压实和密实 EOS 增加刚度时更新局部稳定时间步，小变形模式也启用自适应时间步。

## 整体求解、输出与边界

正交各向异性材料在初始平衡、内力和显式稳定步长中均使用旋转后的真实刚度。柔度 Voigt 顺序为 xx、yy、zz、xy、yz、xz，法向耦合 `S12=−ν12/E1`、`S23=−ν23/E2`、`S13=−ν13/E1`，对称性给出反向泊松比。面内角度从全局 X 轴逆时针计，3 轴为面外方向。吸收边界通过法向声学张量的特征分解构造阻抗，仍为局部近似。

材料卡送入原生核心时保留旧数字前缀，新模型追加 `SOLID1` 和该活动参数组的数字，双方检查完整字段、版本及额外尾随数据。JC 密度由求解元素提供，不在 sidecar 重复。新的原生元数据含 `solidConstitutiveVersion:1`；旧核心会在读卡/版本检查时失败，不会静默按旧模型计算。

新固体模型出现时，每单元有 14 个 Float64：`[εxx,εyy,γxy,σxx,σyy,τxy,d,σzz,ep,非弹性功密度,T,硬化压力,塑性体积应变,历史最大体积压缩]`。T 是 JC 的 K 温度，硬化压力对 MCC 是 pc，对 Cap 是 pa；不适用字段为 0。老模型仍保持原 7/10 布局。帧解码和 CSV 导出识别新增字段，旧布局仍可读。界面汇总原有 `plasticWork` 键亦包括 Maxwell 黏性耗能，不能将其解释为只有塑性材料才有值。

非线性初始静力平衡尚未实现。超过屈服面的初始预载会报错；超弹性和 HJC 遇到非零初始预载会要求选择突然加载。MCC 必须先作有效围压预平衡。其他有限变形塑性继续沿用现有共旋率积分，并非乘法分解有限应变塑性。塑性功和 HJC 储能是相应离散更新的诊断量，不能把总能量残差全解释成断裂能。二维连续网格仍不包含重网格、裂面接触、碎块碰撞或单元侵蚀。

## 开源来源与许可

已实际下载并阅读以下 GitHub 源码，并保留在 `third_party/solid-reference/`：

- [CB-Geo/mpm](https://github.com/CB-Geo/mpm)，固定提交 `53fcb7609375fd44bf3481d24ee18bfdf0393adb`：Mohr–Coulomb 与 Modified Cam-Clay `.tcc`，MIT。参考参数约定、屈服面、流动与指数硬化；改为本项目 Eigen 材料点接口，并限定为上文明确描述的版本。
- [Arcidiacono/Abaqus-VUMAT-Johnson-Cook](https://github.com/mauroarcidiacono/Abaqus-VUMAT-Johnson-Cook)，固定提交 `3b8188dd14f810809246b05ded0aa53134b74dc5`：`JC_VUMAT.for`，MIT。参考塑性速率返回、热参数与材料点状态组织；未导入 Abaqus 依赖和其损伤/侵蚀扩展。

下载文件原样保留，不在运行时编译/调用 Fortran 或 CB-Geo MPM 框架；本项目将必要方程与更新过程改为 C++/Eigen。`manifest.json` 记录原始链接、固定提交和 SHA-256，两套 MIT 原始许可随文件保留。其余模型为按公开方程实现的本地核，没有引入完整外部多物理场库。

方程核对另参考 [Itasca MC](https://docs.itascacg.com/3dec700/common/models/mohr/doc/modelmohr.html)、[Itasca MCC](https://docs.itascacg.com/flac3d700/common/models/camclay/doc/modelcamclay.html)、[MOOSE Maxwell](https://mooseframework.inl.gov/source/materials/GeneralizedMaxwellModel.html)、[FElupe 超弹性能量源码](https://felupe.readthedocs.io/en/v7.16/_modules/felupe/constitution/_models_hyperelasticity_ad.html) 和 [IMPETUS HJC 方程说明](https://www.impetus.no/support/manual/?command=MAT_HJC_CONCRETE)。这些资料中的其他公式/选项不自动构成本实现的一部分。

## 验证

本次正式核心的构建、校验和与 284 项全套测试结果见 [验证记录](SOLID_VERIFICATION.md)。

```powershell
.\node-v24.21.0-win-x64\node.exe --test tests/solid-constitutive.test.js tests/solid-ui.test.js tests/solid-blast.test.js
.\node-v24.21.0-win-x64\node.exe --test tests/*.test.js
```

材料点验证覆盖解析 J2、JC 塑性应变率和升温、MC 棱边/顶点/随机三轴路径与旋转、Prony 解析松弛和耗能、超弹性能量导数与刚体旋转、MCC 屈服/硬化一致性、Cap 压实硬化、Perzyna 隐式流动、正交柔度和方向、HJC 不可逆压实与静止状态。集成验证逐一运行所有新增模型、多材料混合、材料卡存储、显示单位转换、初始屈服检查和新增帧/CSV 字段。数值验证不等于实际材料标定或与商业求解器的逐工况等价认证。
