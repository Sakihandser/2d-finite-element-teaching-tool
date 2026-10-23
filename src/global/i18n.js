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
    "已启用": "Enabled",
    "未启用": "Inactive",
    "夜间无人值守保护": "Unattended overnight protection",
    "训练期间阻止 Windows 自动空闲休眠，允许熄屏。文件保存失败自动重试；显存不足可回退 CPU，数值异常可从完整检查点降低学习率恢复，运行异常最多恢复 2 次。请接通电源并保持训练服务运行；关机、手动休眠或合盖仍可能中断。": "Prevent automatic Windows idle sleep during training while allowing the display to turn off. Retry file saves; fall back to CPU on CUDA out-of-memory errors or restore a complete checkpoint at a lower learning rate for numerical errors, with at most 2 runtime recoveries. Keep power connected and the training service running. Shutdown, explicit sleep or closing the lid may still interrupt training.",
    "文件访问暂时失败，正在自动重试保存。": "File access failed temporarily; automatically retrying the save.",
    "显存不足后已自动切换 CPU，训练速度可能降低。": "Automatically switched to CPU after a CUDA out-of-memory error. Training may be slower.",
    "已从完整检查点自动恢复训练；显存不足时切换 CPU，数值异常时降低学习率。": "Automatically resumed from a complete checkpoint, using CPU for CUDA out-of-memory errors or a lower learning rate for numerical errors.",
    "自动恢复失败，请检查数据、设备或磁盘；最近完整检查点已保留。": "Automatic recovery failed. Check the data, device or disk; the latest complete checkpoint is retained.",
    "没有数值有效的完整检查点，无法自动恢复。": "No numerically valid complete checkpoint is available for automatic recovery.",
    "训练图数量与元数据不一致，请重新导入。": "The graph count differs from the metadata. Import the case again.",
    "自动调整、恢复最佳模型与早停": "Automatic adjustment, best-model recovery and early stopping",
    "平台期等待轮数": "Plateau patience (epochs)",
    "自动恢复次数上限": "Maximum automatic recoveries",
    "连续过拟合 3 轮或进入平台期时，自动恢复最佳权重、降低当前学习率；过拟合时加强权重衰减和 Dropout。重试耗尽或持续无改善时早停，结束时恢复最佳模型。早停设为 0 时仍按轮数上限结束；无独立验证集时仅调整学习率。": "After 3 consecutive overfitting epochs or a plateau, restore the best weights and lower the current learning rate. Increase weight decay and dropout for overfitting. Stop early when retries are exhausted or progress stalls, and finish with the best model. Setting early stopping to 0 keeps the epoch limit. Without independent validation, only the learning rate is adjusted.",
    "已自动恢复最佳验证权重，使用更低学习率继续尝试；过拟合时同步加强正则化。": "Automatically restored the best validation weights and resumed at a lower learning rate. Regularization is also strengthened for overfitting.",
    "自动训练已结束，当前权重已恢复到本阶段最佳验证模型，无需手动回退。": "Automatic training has finished with this phase's best validation model restored. No manual rollback is needed.",
    "最佳检查点的数据划分与当前训练不一致，无法自动恢复。": "The best checkpoint uses a different dataset split; automatic recovery is unavailable.",
    "已自动恢复最佳验证权重，降低学习率后重试。": "Automatically restored the best validation weights and retried with a lower learning rate.",
    "恢复此检查点权重": "Restore weights from this checkpoint",
    "先选择检查点并“恢复此检查点权重”：建立独立记录、进入待训练状态，不要求旧工况文件，也不立即开训。再勾选训练数据，点击下方“继续训练”，仅使用当前勾选的训练集和验证集。原模型与后续检查点保留；预测仍使用指定检查点，自动预测优先最佳验证版本。": "Select a checkpoint and restore its weights into a separate record awaiting training. Original case files are optional. Then select data and click Resume training to use only the currently selected training and validation sets. The original model and later checkpoints are retained. Predictions use the selected checkpoint, or prefer the best validation checkpoint in automatic mode.",
    "继续训练仅使用当前勾选的数据。同一数据集暂停后可恢复优化器和读取进度；更换数据后开始新阶段。恢复检查点权重后会重建优化器，并追加上方设置的轮数。按设定间隔自动保存，暂停及完成时也会保存。": "Resume uses only selected data. With the same dataset, optimizer state and data position are restored; changing data starts a new phase. Restoring checkpoint weights rebuilds the optimizer and adds the configured epochs. Checkpoints save at the configured interval, on pause and on completion.",
    "输入粗网格是读取几何和物理条件的载体。学习答案是自适应参考网格投影得到的局部目标尺寸，不是让 AI 照抄粗网格。每个三角形对应一个图节点，输入位置、当前尺寸、材料、支撑、载荷和误差条件等 23 项特征。": "The coarse input mesh represents geometry and physical conditions. Local target sizes are projected from the adaptive reference mesh. Each triangle is a graph node with 23 features, including position, current size, material, supports, loads and error conditions.",
    "粗单元着色": "Coarse element coloring",
    "学习目标：尺寸加密倍率": "Learning target: refinement ratio",
    "学习目标：局部目标尺寸": "Learning target: local size",
    "仅查看输入网格": "View input mesh only",
    "训练工况选择必须是列表。": "Training case selection must be a list.",
    "检查点权重已恢复为独立记录；尚未启动训练，请勾选当前训练数据后点击“继续训练”。": "Checkpoint weights were restored into a separate record. Select current training data and click Resume training.",
    "已按当前勾选和学习用途更新训练集与验证集。": "Training and validation sets were updated using the current selection and split assignments.",
    "网格处理进程已退出。": "The mesh processing worker has exited.",
    "网格处理超时。": "Mesh processing timed out.",
    "未知网络结构版本。": "Unknown network architecture version.",
    "没有训练图可用于特征标准化。": "No training graphs are available for feature normalization.",
    "网络退化为近似常量尺寸修正，未学到局部变化。建议使用新结构开始新训练，并保留独立验证集。": "The network predicts nearly constant size corrections and has not learned local variation. Start a new training run with the new architecture and retain independent validation data.",
    "已按节点预算停止细化。": "Refinement stopped at the node budget.",
    "待训练": "Ready to train",
    "原权重的训练几何历史不完整，无法确认验证集独立性": "The original training geometry history is incomplete; validation independence cannot be confirmed",
    "原权重的训练几何历史不完整，无法确认验证集独立性；已禁用基于该验证集的自动早停。": "The original training geometry history is incomplete; validation independence cannot be confirmed. Automatic early stopping on this validation set is disabled.",
    "参考网格提供局部目标尺寸，作为监督答案；其最终节点、位移和应力不作为网络输入。切换到输入粗网格可查看学习目标。": "The reference mesh provides local target sizes for supervision. Its final nodes, displacements and stresses are excluded from network inputs. Switch to a coarse input mesh to view learning targets.",
    "这张粗网格提供输入特征；着色显示每个粗单元应学到的答案，不是 AI 预测结果。": "This coarse mesh provides input features. Colors show the target for each coarse element, rather than AI predictions.",
    "当前仅显示输入网格；可切换着色查看每个粗单元的学习答案。": "Only the input mesh is shown. Switch the coloring to view targets for each coarse element.",
    "这张粗网格提供输入特征；该工况暂无法显示学习答案。": "This coarse mesh provides input features. Learning targets are currently unavailable for this case.",
    "几何、材料、支撑和载荷决定网络输入的物理条件。": "Geometry, materials, supports and loads define the physical conditions supplied to the network.",
    "参考网格（监督来源）": "Reference mesh (supervision source)",
    "正在读取勾选数据并继续训练…": "Reading selected data and resuming training…",
    "已使用当前勾选的数据继续训练。": "Resumed training with the current data selection.",
    "正在恢复检查点权重，恢复后等待继续训练…": "Restoring checkpoint weights; training will wait for resume…",
    "检查点权重已恢复为独立记录，尚未开训。请勾选训练数据，再点击训练控制中的“继续训练”。": "Checkpoint weights were restored into a separate record. Select training data and click Resume training to start.",
    "标签版本不兼容，无法重建学习目标。": "The label version is incompatible; learning targets cannot be reconstructed.",
    "自适应训练策略": "Adaptive training strategy",
    "自动：续训用最新，预测优先最佳验证": "Automatic: latest for resume, best validation for prediction",
    "自动续训使用最新检查点，自动预测优先使用最佳验证检查点；手动指定检查点时，续训创建独立分支，预测使用指定版本。训练轮数沿用下方设置，训练期间暂停管理操作。": "Automatic resume uses the latest checkpoint; automatic prediction prefers the best validation checkpoint. A manual selection creates a separate branch for resume and uses that version for prediction. Epochs follow the settings below. Pause training before management operations.",
    "尺寸偏差因子由平均对数尺寸误差换算；偏粗、偏细区域分别统计预测尺寸大于参考的 1.25 倍、小于 0.8 倍的面积比例。标签对照优先显示验证集，没有验证集时显示训练集。": "The size-deviation factor is derived from mean absolute log-size error. Coarser and finer fractions measure areas with predicted sizes above 1.25 times or below 0.8 times the reference. Reference comparisons show validation data when available, otherwise training data.",
    "自动调整学习率与早停": "Automatic learning-rate adjustment and early stopping",
    "降学习率等待轮数": "Learning-rate patience (epochs)",
    "早停等待轮数（0 为禁用）": "Early-stopping patience (0 disables)",
    "指标停滞时学习率减半；独立验证指标持续未改善时提前停止，保留最佳验证检查点。没有独立验证集时不自动早停。": "Halve the learning rate when progress stalls. Stop early if independent validation does not improve, retaining the best validation checkpoint. Automatic early stopping requires independent validation.",
    "训练诊断与标签对照": "Training diagnostics and reference comparison",
    "完成一轮训练后显示诊断。": "Diagnostics appear after a completed epoch.",
    "损失是参考网格尺寸标签的拟合差异，不是有限元误差。偏细不一定更好，偏粗不一定更差；优于参考网格需通过有限元误差与节点数对比验证。新曲线使用同一轮末权重、按几何均衡评估；虚线处表示数据或评估口径调整，旧记录保留。": "Loss measures agreement with reference mesh-size labels, not finite-element error. Finer is not necessarily better and coarser is not necessarily worse; compare finite-element errors and node counts to establish improvement. New curves use the same end-of-epoch weights and equal geometry weighting. Dashed lines mark changes in data or evaluation; historical records are retained.",
    "数据或评估口径调整": "Data or evaluation changed",
    "验证几何曾参与训练，不能作为独立泛化验证": "Validation geometry was previously trained on; it is not an independent generalization test",
    "当前未触发明显的拟合风险，继续观察验证趋势。": "No clear fitting risk has been flagged; continue monitoring validation trends.",
    "没有验证集；仅调整学习率，不自动判断过拟合或早停。": "No validation set: only learning-rate adjustment is available; no automatic overfitting diagnosis or early stopping.",
    "验证几何曾参与训练；已禁用基于该验证集的自动早停。": "Validation geometry was previously used for training. Automatic early stopping based on this set is disabled.",
    "当前数据阶段轮数较少，继续观察趋势。": "Few epochs have completed in this data phase. Continue observing the trend.",
    "存在过拟合风险：验证表现变差且明显落后于训练。": "Overfitting risk: validation has worsened and clearly trails training performance.",
    "尚未优于基础网格标签基线；可能训练不足、模型能力不足或标签存在差异。": "The initial-mesh label baseline has not been beaten. Possible causes include insufficient training, model capacity or label differences.",
    "验证指标进入平台期，正在观察学习率调整效果。": "Validation has plateaued. Monitoring the effect of learning-rate adjustment.",
    "已因验证指标持续未改善而早停；可使用最佳验证检查点预测。": "Stopped early after persistent lack of validation improvement. The best validation checkpoint is available for prediction.",
    "评估指标出现非有限值，已停止训练。": "Training stopped because an evaluation metric became non-finite.",
    "验证或训练指标停滞，已自动降低学习率。": "Validation or training progress stalled. The learning rate was reduced automatically.",
    "验证指标持续未改善，已提前停止；最佳验证检查点已保留。": "Stopped early after persistent lack of validation improvement. The best validation checkpoint was retained.",
    "最佳验证检查点不可用，预测使用最新可用检查点。": "The best validation checkpoint is unavailable. Prediction uses the latest available checkpoint.",
    "服务已重启；已完成工况保留，未完成工况未导入。": "The service restarted. Completed cases are retained; unfinished cases have not been imported.",
    "已有数据生成任务正在运行。": "A data generation task is already running.",
    "请先保存并暂停神经网络训练，再生成参考数据。": "Save and pause network training before generating reference data.",
    "历史批次路径无效。": "Invalid historical batch path.",
    "工况进程超过耗时保护，已跳过。": "The case process exceeded its time limit and was skipped.",
    "工况进程异常退出。": "The case process exited unexpectedly.",
    "该工况已存在于另一数据集中；请保留原用途，或使用新种子生成不同几何。": "This case already exists in the other dataset split. Keep its current split or use a new seed to generate different geometry.",
    "工况路径无效。": "Invalid case path.",
    "找不到生成记录。": "Generation record not found.",
    "历史删除目标超出生成数据目录。": "The deletion target is outside the generated-data directory.",
    "历史目录包含链接，已拒绝删除。": "Deletion was refused because the history directory contains links.",
    "历史目录包含不支持的文件类型。": "The history directory contains an unsupported file type.",
    "请选择有效的历史删除范围。": "Select a valid history deletion scope.",
    "历史工况编号无效。": "Invalid historical case identifier.",
    "找不到历史工况。": "Historical case not found.",
    "请等待生成或历史管理操作完成后再删除。": "Wait for generation or history management to finish before deleting.",
    "请等待生成或历史管理操作完成后再操作。": "Wait for generation or history management to finish before continuing.",
    "请先保存并暂停训练，再管理生成历史。": "Save and pause training before managing generation history.",
    "历史文件或分配状态已改变，请重新查看删除清单后确认。": "Historical files or assignments changed. Review the deletion list again before confirming.",
    "请选择训练集或验证集。": "Select the training or validation set.",
    "工况没有可分配的参考模型文件。": "This case has no reference model available for assignment.",
    "该历史工况已经分配，请在训练数据列表中管理。": "This historical case is already assigned. Manage it in the training data list.",
    "历史参考模型必须是生成目录内的普通文件。": "The historical reference model must be a regular file inside the generated-data directory.",
    "该工况已存在于另一数据集中；同一几何的工况不能跨训练集和验证集。": "This case already exists in the other split. Cases sharing geometry cannot span training and validation sets.",
    "该历史工况尚未分配到训练库。": "This historical case has not been assigned to the dataset library.",
    "缺少机器学习环境，请先运行 scripts/setup-ml.ps1。": "The machine learning environment is missing. Run scripts/setup-ml.ps1 first.",
    "训练服务响应超时，请刷新状态查看后台任务。": "The training service response timed out. Refresh the status to check background tasks.",
    "数据生成任务正在运行，请等待完成或停止后再操作训练和模型管理。": "Data generation is running. Wait for it to finish or pause before training or managing models.",
    "无效的记录编号。": "Invalid record identifier.",
    "当前使用 CPU；未发现通过网络训练自检的 GPU 后端，或已指定 CPU。": "Using CPU: no GPU backend passed the network training check, or CPU was explicitly selected.",
    "当前使用 DirectML；部分图聚合算子会在 CPU 执行，速度取决于显卡与图规模。": "Using DirectML. Some graph aggregation operations run on CPU; performance depends on the GPU and graph size.",
    "该训练记录已被另一程序实例使用，请先在该实例中暂停。": "This training run is in use by another application instance. Pause it there first.",
    "请先暂停训练，待保存完成后再执行此操作。": "Pause training and wait for saving to finish before performing this operation.",
    "网格准备失败。": "Mesh preparation failed.",
    "请选择有效的模型 JSON 文件。": "Select a valid model JSON file.",
    "样本用途必须是训练或验证。": "The dataset split must be training or validation.",
    "相同几何的载荷工况必须放在同一组，不能跨训练集和验证集。": "Load cases sharing geometry must remain in the same split, without spanning training and validation.",
    "请至少选择一个训练工况。": "Select at least one training case.",
    "训练集与验证集存在相同几何，不能开始训练。": "Training cannot start because the training and validation sets share geometry.",
    "样本特征版本不兼容，请重新导入。": "The sample feature version is incompatible. Import the sample again.",
    "请求的计算设备与当前后端不匹配，请重启服务后选择相应环境。": "The requested device does not match the current backend. Restart the service with the appropriate environment.",
    "检查点特征版本不兼容。": "The checkpoint feature version is incompatible.",
    "原 GPU 随机状态与当前设备不兼容，保留模型和优化器并使用当前随机状态。": "The saved GPU random state is incompatible with this device. The model and optimizer are retained with the current random state.",
    "尚无训练任务。": "No training task exists yet.",
    "请先从完整检查点恢复，再保存训练。": "Restore a complete checkpoint before saving training.",
    "损失出现非有限值，已停止训练。": "Training stopped because the loss became non-finite.",
    "请先训练或选择一个检查点。": "Train a model or select a checkpoint first.",
    "该检查点尚未完成任何训练步。": "This checkpoint has not completed any training steps.",
    "节点预算小于几何基础网格节点数，请提高节点预算。": "The node budget is smaller than the initial geometry mesh. Increase the node budget.",
    "未知训练操作。": "Unknown training operation.",
    "无效的训练工况编号。": "Invalid training case identifier.",
    "训练工况不存在或路径无效。": "The training case does not exist or its path is invalid.",
    "该训练工况缺少可预览的几何参考文件，请重新导入原模型。": "This case lacks a previewable geometry reference. Import the original model again.",
    "请选择 1–1000 个训练工况。": "Select 1–1000 training cases.",
    "模型记录编号无效。": "Invalid model record identifier.",
    "有训练记录正被另一程序实例使用，请先暂停再操作数据。": "A training run is in use by another instance. Pause it before modifying data.",
    "数据或训练记录已改变，请重新查看删除清单后确认。": "Data or training records changed. Review the deletion list again before confirming.",
    "选中数据被训练记录引用，删除前需要确认对继续训练和模型导出的影响。": "Selected data is referenced by training runs. Review the impact on resumed training and model export before deleting.",
    "GPU 探测达到总耗时限制，继续尝试 CPU。": "GPU detection reached its total time limit. Trying CPU next.",
    "DirectML 的部分图聚合算子会在 CPU 执行，速度取决于显卡与图规模。": "Some DirectML graph aggregation operations run on CPU; performance depends on the GPU and graph size.",
    "数据生成请求失败。": "The data generation request failed.",
    "工况文件读取失败。": "Failed to read the case file.",
    "全选工况": "Select all cases",
    "取消勾选": "Clear selection",
    "删除勾选工况": "Delete selected cases",
    "勾选用于训练和批量删除；点击工况名称或预览按钮查看模型。删除会永久移除训练库中的工况文件，确认框会列出受影响的训练记录。": "Checked cases are used for training and batch deletion. Click a case name or Preview to inspect its model. Deletion permanently removes dataset files; the confirmation lists affected training records.",
    "管理": "Manage",
    "工况模型预览": "Case model preview",
    "工况模型预览：": "Case model preview:",
    "关闭预览": "Close preview",
    "预览内容": "Preview content",
    "几何、材料与载荷": "Geometry, materials and loads",
    "训练工况几何与网格预览": "Training case geometry and mesh preview",
    "正在读取工况模型…": "Loading case model…",
    "输入粗网格": "Input coarse mesh",
    "部分文件删除失败，请刷新列表后重试。": "Some files could not be deleted. Refresh the list and retry.",
    "正在核对工况文件与训练记录的关联…": "Checking dataset files and training dependencies…",
    "被以下训练记录引用：": "Referenced by these training records:",
    "永久删除所选工况的整个训练数据目录（参考模型、训练图和元数据）？文件无法恢复。原始导入 JSON 和生成批次文件保留。": "Permanently delete the selected dataset directories, including reference models, training graphs and metadata? Files cannot be recovered. Original imported JSONs and generated batch files are retained.",
    "部分检查点不可读取，无法确认其数据依赖。": "Some checkpoints cannot be read, so their dataset dependencies are unknown.",
    "删除清单已准备，请在确认框中核对。": "Deletion details are ready. Review the confirmation dialog.",
    "已取消删除。": "Deletion canceled.",
    "预览失败：": "Preview failed:",
    "自动生成训练数据": "Generate training data",
    "尚未生成": "No generated data yet",
    "随机拼装与合并几何 → 划分材料区域 → 施加支撑和载荷 → 有限元求解与 ZZ 自适应加密 → 加入训练数据。同一几何的所有工况使用相同数据用途。": "Assemble and merge shapes → partition material regions → prescribe supports and loads → solve and refine with ZZ → add training data. All cases sharing a geometry stay in the same dataset split.",
    "随机种子": "Random seed",
    "几何数量": "Geometries",
    "每个几何的工况数": "Cases per geometry",
    "验证几何比例": "Validation geometry fraction",
    "最多拼装图形": "Maximum primitives",
    "最多结构区域": "Maximum solid regions",
    "最多孔洞": "Maximum holes",
    "目标 ZZ 相对误差": "Target relative ZZ error",
    "可用图形": "Available shapes",
    "椭圆": "Ellipse",
    "随机多边形": "Random polygon",
    "随机载荷（点力 N，线载荷 N/m，体力为加速度）": "Random loads (point: N; line: N/m; body: acceleration)",
    "线性分布载荷": "Linearly varying traction",
    "网格、尺寸、材料和质量选项": "Mesh, dimensions, materials and quality",
    "图形最小尺寸 m": "Minimum primitive size (m)",
    "图形最大尺寸 m": "Maximum primitive size (m)",
    "最小点力 / 线载荷强度": "Minimum force / traction intensity",
    "最大点力 / 线载荷强度": "Maximum force / traction intensity",
    "基础节点预算": "Seed node budget",
    "参考节点上限": "Reference node limit",
    "最多自适应加密轮数": "Maximum refinement rounds",
    "每个工况最多加密轮数": "Maximum refinement rounds per case",
    "载荷组合方式": "Load combination sampling",
    "均衡抽样": "Balanced sampling",
    "全部所选类型": "All selected types",
    "点载荷形式": "Point-load representation",
    "理想集中力": "Ideal point force",
    "有限宽度边界载荷": "Finite-width boundary load",
    "加载宽度占边长比例": "Loaded fraction of edge length",
    "支撑形式": "Support representation",
    "单条外边界": "Single exterior edge",
    "连续直线外边界": "Continuous straight exterior boundary",
    "有限宽度模式在自由边中部施加对称分布载荷，记录实际宽度与合力。": "Finite-width mode applies symmetric traction at the center of a free edge and records its physical width and resultant.",
    "点载荷形式或支撑形式无效。": "Invalid point-load or support representation.",
    "载荷组合方式必须是全部所选类型或均衡抽样。": "Load sampling must be all selected types or balanced sampling.",
    "奇点保护限制": "Singularity protection limit",
    "误差下降停滞": "Error reduction stalled",
    "加密失败，保留已解网格": "Refinement failed; solved mesh retained",
    "每轮耗时上限 秒": "Time limit per round (s)",
    "工况总耗时上限 秒": "Total reference-case time limit (s)",
    "每轮耗时上限": "Round time limit",
    "工况总耗时上限": "Total case time limit",
    "加密轮数不含基础网格的首次求解，0 表示只求解基础网格。每轮和工况总耗时分别限制单轮计算与整个参考工况计算；达到轮数、耗时或节点上限均不代表精度达标。设置在批次开始时生效。": "Refinement rounds exclude the initial mesh solve; 0 solves only the initial mesh. Round and total-case limits apply to one round and the whole reference-case computation respectively. Reaching a round, time or node limit does not indicate target accuracy. Settings take effect when a batch starts.",
    "自动加入用途": "Automatic import split",
    "重置种子为当前时间戳": "Reset seed to the current local timestamp",
    "刷新": "Refresh",
    "自适应加密后整张参考网格的总计算节点数上限；基础网格由基础节点预算控制。": "Maximum total analysis nodes in the adaptively refined reference mesh; the initial mesh uses the initial-node budget.",
    "圆和椭圆采用 24 段多边形近似。随机固定完整外边界，排除孔壁和内部材料界面；体力加速度在 1–20 m/s² 随机采样。材料值在批次启动时保存。选择按比例划分时，验证用途按种子和几何编号确定，小批次可能没有验证样本。": "Circles and ellipses use 24-segment polygon approximations. A whole exterior edge is fixed; hole walls and material interfaces are excluded. Body acceleration is sampled from 1–20 m/s². Material values are saved at batch start. When splitting by fraction, validation is assigned by seed and geometry index; small batches may have no validation cases.",
    "按验证几何比例自动划分": "Split by validation geometry fraction",
    "全部加入训练集": "Import all into training",
    "全部加入验证集": "Import all into validation",
    "仅自动加入实际 ZZ 误差不高于目标的有效工况。未达标的参考文件保留在历史中，可检查后手动分配。指定训练集或验证集时，验证几何比例不参与分配；同一几何不能跨用途。": "Automatically import only valid cases whose achieved ZZ error is at most the target. References below target quality remain in history for review and manual assignment. A fixed training or validation split overrides the fraction; the same geometry cannot span splits.",
    "每轮耗时保护 秒": "Time limit per round (s)",
    "材料范围": "Material selection",
    "全部有效材料随机分配": "Randomly assign valid library materials",
    "仅将达到目标误差的工况加入训练": "Import only cases reaching the target error",
    "启用现有 GPU 单元计算": "Use GPU element calculations",
    "圆和椭圆采用 24 段多边形近似。随机固定完整外边界，排除孔壁和内部材料界面；体力加速度在 1–20 m/s² 随机采样。材料值在批次启动时保存。验证用途按种子和几何编号确定，小批次可能没有验证样本。": "Circles and ellipses use 24-segment polygon approximations. A random exterior edge is fixed; hole walls and material interfaces are excluded. Body acceleration is sampled from 1–20 m/s². Material values are saved at batch start. Validation is assigned by seed and geometry index; small batches may have no validation cases.",
    "计算后自动加入训练数据": "Automatically import generated references",
    "预览随机模型": "Preview random model",
    "开始批量生成": "Generate batch",
    "完成当前工况后停止": "Stop after current case",
    "完成当前工况后暂停": "Pause after current case",
    "继续所选批次": "Resume selected batch",
    "暂停会等待当前工况完成并保存进度。选择已暂停、已停止或中断的批次可继续生成，沿用原始参数与随机种子；已完成和已失败的工况不会重跑。重启程序后也可继续。": "Pausing finishes the current case and saves progress. Resume a paused, stopped or interrupted batch with its original parameters and random seed. Completed and failed cases are skipped. Batches can also be resumed after restarting the program.",
    "正在请求暂停生成…": "Requesting generation pause…",
    "暂停请求已提交，当前工况完成并保存后暂停。": "Pause requested. Generation will pause after the current case finishes and is saved.",
    "正在恢复生成批次…": "Resuming generation batch…",
    "正在按原始参数继续生成剩余工况。": "Generating the remaining cases with the original parameters.",
    "请选择已暂停、已停止或中断的批次。": "Select a paused, stopped or interrupted batch.",
    "此批次没有剩余工况。": "This batch has no remaining cases.",
    "预览第一个几何和工况，生成过程在后台运行。切换页面不会停止生成。": "Preview the first geometry and case. Generation runs in the background and continues when switching pages.",
    "载入预览到结构绘制页": "Load preview into Structure",
    "生成器已准备。先预览可检查参数效果；已有模型不会被批量生成操作覆盖。": "Generator ready. Preview to inspect the settings; batch generation preserves the current drawing model.",
    "生成记录": "Generation history",
    "历史记录管理": "Manage generation history",
    "删除所有历史生成数据": "Delete all generated history",
    "删除已分配历史生成数据": "Delete assigned generated history",
    "删除当前批次": "Delete selected batch",
    "历史删除会直接移除对应生成文件；已分配到训练库的副本和模型检查点保留。未分配的有效参考模型可手动分配到训练集或验证集，同一几何的工况仍需放在同一数据集中。": "Deleting history permanently removes the generated files. Training-library copies and model checkpoints are retained. Assign valid unassigned references to training or validation; cases with the same geometry must use the same split.",
    "分配情况": "Assignment",
    "结果与管理": "Output and management",
    "删除历史生成数据": "Delete generated history",
    "确认永久删除": "Confirm permanent deletion",
    "已分配": "Assigned",
    "未分配": "Unassigned",
    "分配": "Assign",
    "训练副本已删除，可重新分配": "Training copy deleted; available to reassign",
    "正在分配历史工况并建立三种输入粗网格…": "Assigning the historical case and building three input coarse meshes…",
    "该工况已在训练库中，分配状态已更新。": "This case is already in the training library; its assignment was updated.",
    "历史工况已成功分配。": "Historical case assigned successfully.",
    "对应历史文件已删除，预览已清除。": "The historical files were deleted and the preview was cleared.",
    "正在核对历史生成文件…": "Checking generated history files…",
    "没有符合条件的历史生成数据。": "No generated history matches this selection.",
    "确认永久删除这些历史生成文件？源模型、参考模型、求解结果和对应历史记录将直接从磁盘删除，无法恢复。训练库中的独立副本与模型检查点保留。": "Permanently delete these generated history files? Source models, reference models, solver results and matching history records will be removed from disk and cannot be recovered. Independent training-library copies and model checkpoints are retained.",
    "所有历史生成数据": "All generated history",
    "已分配历史生成数据": "Assigned generated history",
    "当前历史批次": "Selected history batch",
    "所选历史工况": "Selected historical case",
    "历史删除清单已准备，请核对。": "The history deletion list is ready for review.",
    "正在永久删除历史生成文件…": "Permanently deleting generated history files…",
    "部分历史文件删除失败，请重新查看清单后重试。": "Some history files could not be deleted. Review the list and try again.",
    "下载批次记录": "Download batch manifest",
    "参考网格": "Reference mesh",
    "实际 ZZ 误差": "Achieved ZZ error",
    "结果": "Output",
    "尚未生成工况。": "No cases generated yet.",
    "随机模型几何、支撑及载荷预览": "Preview of random geometry, supports and loads",
    "数据生成进度": "Data generation progress",
    "生成中": "Generating",
    "已中断": "Interrupted",
    "已停止": "Stopped",
    "已生成": "Generated",
    "已加入训练": "Imported",
    "已存在": "Already imported",
    "未达到目标，未导入": "Below target quality; not imported",
    "生成成功，导入失败": "Generated; import failed",
    "达到目标误差": "Target error reached",
    "加密轮数上限": "Refinement round limit",
    "节点预算上限": "Node budget limit",
    "耗时上限": "Time limit",
    "局部尺寸限制": "Local size limit",
    "无可细化单元": "No refinable elements",
    "预览": "Preview",
    "预览已更新。可开始批量求解，或载入结构页检查。": "Preview updated. Generate the batch or load the preview into Structure.",
    "正在拼装几何、划分区域并生成物理条件…": "Assembling geometry, partitioning regions and generating physics…",
    "正在建立数据生成任务…": "Creating a data generation batch…",
    "批量生成已开始。": "Batch generation started.",
    "正在请求停止…": "Requesting stop…",
    "停止请求已提交，当前工况完成后停止。": "Stop requested. The current case will finish first.",
    "正在读取生成工况…": "Loading generated case…",
    "工况预览已更新。": "Case preview updated.",
    "正在读取生成记录…": "Loading generation history…",
    "生成记录已更新。": "Generation history updated.",
    "绿色：固定支撑   红色：外载荷   紫色：体力": "Green: fixed supports   Red: loads   Purple: body forces",
    "生成几何": "Generating geometry",
    "生成参考网格": "Building reference mesh",
    "有限元求解": "Solving FEA",
    "ZZ 自适应加密": "Refining with ZZ",
    "准备训练图": "Preparing training graphs",
    "准备中": "Preparing",
    "模型包包含检查点和依赖样本，可在本程序中导入恢复；也支持导入完整 PT 检查点，但需已有对应样本。删除模型和检查点会永久删除文件，共享样本保留。": "Packages include checkpoints and required samples. Full PT checkpoints require matching local samples. Deleting models and checkpoints permanently removes their files; shared samples are kept.",
    "存储清理": "Storage cleanup",
    "清理会永久删除文件，不影响模型检查点和训练样本。导出包与预测 JSON 按全局清理；已下载到其他位置的副本不受影响。下方显示项目数 / 占用大小。": "Cleanup permanently removes files without affecting model checkpoints or training samples. Export packages and prediction JSONs are cleared across all models; copies downloaded elsewhere are kept. Counts / sizes are shown below.",
    "删除暂存导出包": "Delete temporary export packages",
    "删除预测 JSON": "Delete prediction JSONs",
    "清理历史删除残留": "Clean up previously deleted data",
    "暂存导出包": "Temporary export packages",
    "预测 JSON": "Prediction JSONs",
    "历史删除残留": "Previously deleted data",
    "永久删除选中的检查点？文件无法恢复，至少需要保留一个可用检查点。": "Permanently delete this checkpoint? Files cannot be recovered. At least one usable checkpoint must remain.",
    "永久删除当前模型及其全部检查点？文件无法恢复，共享样本不会删除。": "Permanently delete this model and all its checkpoints? Files cannot be recovered. Shared samples will be kept.",
    "永久清理此类别的全部暂存文件？文件无法恢复，模型检查点和训练样本不受影响。": "Permanently clear all temporary files in this category? Files cannot be recovered. Model checkpoints and training samples are kept.",
    "文件已永久删除。": "Files permanently deleted.",
    "清理目标超出允许的存储目录。": "Cleanup target is outside the allowed storage directory.",
    "未知的存储清理类别。": "Unknown storage cleanup category.",
    "确认删除": "Confirm deletion",
    "正在删除选中内容…": "Deleting selected data…",
    "选中内容已移入本地回收目录。": "Selected data moved to the local recovery folder.",
    "检查点列表已更新。": "Checkpoint list updated.",
    "模型与检查点管理": "Models and checkpoints",
    "当前模型": "Current model",
    "模型名称": "Model name",
    "输入模型名称": "Enter model name",
    "重命名模型": "Rename model",
    "导出模型包": "Export model package",
    "导入已训练模型": "Import trained model",
    "删除模型": "Delete model",
    "下载模型包": "Download model package",
    "模型包包含检查点和依赖样本，可在本程序中导入恢复；也支持导入完整 PT 检查点，但需已有对应样本。删除内容移入 storage/trash，共享样本保留。": "Packages include checkpoints and required samples for restoring in this app. Full PT checkpoints require matching local samples. Deleted data moves to storage/trash; shared samples are kept.",
    "选择检查点": "Select checkpoint",
    "自动选择最新可用检查点": "Automatically select latest usable checkpoint",
    "刷新检查点": "Refresh checkpoints",
    "从此检查点继续训练": "Resume from this checkpoint",
    "删除选中检查点": "Delete selected checkpoint",
    "自动选择会继续当前模型；指定检查点会创建独立训练分支，保留原模型。训练轮数沿用下方设置；预测也使用选定检查点。至少保留一个可用检查点，训练期间暂停管理操作。": "Automatic selection resumes the current model. Selecting a checkpoint creates a separate training branch and preserves the original. Epochs use the settings below; predictions also use the selected checkpoint. Keep at least one usable checkpoint. Pause training before managing models.",
    "检查点文件": "Checkpoint file",
    "步数 / 完成轮数": "Steps / Completed epochs",
    "训练损失": "Training loss",
    "验证损失": "Validation loss",
    "保存时间": "Saved at",
    "文件大小 / 标记": "Size / Flags",
    "请选择模型以查看检查点。": "Select a model to view its checkpoints.",
    "不可读取": "Unreadable",
    "最新": "Latest",
    "最佳验证": "Best validation",
    "正在重命名模型…": "Renaming model…",
    "模型已重命名。": "Model renamed.",
    "删除当前模型及其全部检查点？内容将移入本地回收目录，共享样本不会删除。": "Delete this model and all its checkpoints? They will move to the local recovery folder. Shared samples will be kept.",
    "正在删除模型…": "Deleting model…",
    "模型已移入本地回收目录。": "Model moved to the local recovery folder.",
    "删除选中的检查点？至少需要保留一个可用检查点。": "Delete the selected checkpoint? At least one usable checkpoint must remain.",
    "正在删除检查点…": "Deleting checkpoint…",
    "检查点已移入本地回收目录。": "Checkpoint moved to the local recovery folder.",
    "正在读取检查点…": "Loading checkpoints…",
    "正在打包模型和训练样本…": "Packaging model and training samples…",
    "模型包已准备好，请点击“下载模型包”。": "Package ready. Click Download model package.",
    "正在导入模型并验证检查点和样本…": "Importing model and validating checkpoints and samples…",
    "模型已导入为独立记录，可继续训练或预测。": "Model imported as a separate record, ready for training or prediction.",
    "已从指定检查点创建训练分支。": "Created a training branch from the selected checkpoint.",
    "无效的检查点文件名。": "Invalid checkpoint filename.",
    "模型记录不存在。": "Model record does not exist.",
    "模型名称需为 1–100 个字符。": "Model name must contain 1–100 characters.",
    "检查点不存在。": "Checkpoint does not exist.",
    "不能删除最后一个可用检查点；如不再需要，请删除整个模型。": "The last usable checkpoint cannot be deleted. Delete the entire model if it is no longer needed.",
    "模型结构参数无效。": "Invalid model architecture parameters.",
    "需要包含优化器和训练状态的完整检查点。": "A complete checkpoint with optimizer and training state is required.",
    "模型样本依赖无效。": "Invalid model sample dependencies.",
    "没有可导出的检查点。": "No usable checkpoints to export.",
    "模型依赖的训练样本不完整，无法导出。": "Required training samples are incomplete; export is unavailable.",
    "模型包解压后超过 1 GiB 或文件数量过多。": "Model package exceeds 1 GiB uncompressed or contains too many files.",
    "请选择本程序导出的模型 ZIP 包或完整 PT 检查点。": "Select a model ZIP exported by this app or a complete PT checkpoint.",
    "模型包检查点清单无效。": "Invalid model package checkpoint list.",
    "模型包包含无效路径或重复文件。": "Model package contains invalid paths or duplicate files.",
    "缺少训练样本，请导入包含样本的模型 ZIP 包。": "Training samples are missing. Import a model ZIP that includes its samples.",
    "模型包中的样本无效。": "Invalid sample data in model package.",
    "样本编号冲突，现有样本与模型包内容不同。": "Sample ID conflict: existing data differs from the package.",
    "模型包超过 512 MiB。": "Model package exceeds 512 MiB.",
    "训练环境已连接。导入自适应模型后即可开始；小样本试训仅用于验证流程。": "Training environment connected. Import an adaptive model to begin; small-sample trials only verify the workflow.",
    "已完成": "Completed",
    "训练": "Training",
    "验证": "Validation",
    "未知": "Unknown",
    "细化轮数上限": "Refinement step limit",
    "达到耗时上限": "Time limit reached",
    "局部尺寸限制": "Local size limit",
    "手动参考网格": "Manual reference mesh",
    "精度为人工假定值": "Accuracy is user-assumed",
    "实际误差；目标未确认达标": "Achieved error; target not confirmed",
    "CUDA 不可用 · 请检查 GPU 环境": "CUDA unavailable · Check the GPU environment",
    "完成一轮训练后显示学习曲线": "Learning curves appear after the first epoch",
    "尚无训练操作记录。": "No training activity yet.",
    "训练请求失败": "Training request failed",
    "该工况已存在，未重复计数。": "This case already exists and was not counted again.",
    "模型已导入，可在数据列表中选择训练用途。": "Model imported. Select it in the data list for training.",
    "模型已导入。": "Model imported.",
    "当前模型": "Current model",
    "正在建立训练任务（自动选择 GPU / CPU）…": "Creating a training run (automatic GPU / CPU selection)…",
    "训练已开始。切换标签页不会中断训练；暂停会先保存检查点。": "Training started. Switching tabs keeps training running; pausing saves a checkpoint first.",
    "正在请求保存并暂停…": "Requesting save and pause…",
    "正在完成当前训练步并保存，状态变为“已暂停”后可关闭程序。": "Finishing the current step and saving. Close the program after the status becomes Paused.",
    "正在请求保存检查点…": "Requesting a checkpoint save…",
    "保存请求已提交，请查看检查点步数和训练记录。": "Save requested. Check the saved step and training log for confirmation.",
    "正在恢复模型、优化器与训练进度…": "Restoring the model, optimizer, and training progress…",
    "已恢复训练。": "Training resumed.",
    "正在导入模型并建立三种粗网格，请稍候…": "Importing models and building three coarse meshes. Please wait…",
    "正在提取当前模型的几何与自适应参考网格…": "Extracting the current geometry and adaptive reference mesh…",
    "正在读取本机 JSON 并准备训练样本…": "Reading the local JSON and preparing training samples…",
    "正在预测当前模型的局部尺寸并生成约束网格…": "Predicting local sizes and generating a constrained mesh…",
    "无法读取预测网格。": "Unable to read the predicted mesh.",
    "达到节点预算，已保留上一张网格。": "Node budget reached; the previous mesh was kept.",
    "预测网格已生成，可下载或应用到计算页。": "Predicted mesh ready. Download it or apply it to the analysis page.",
    "当前模型已改变，请重新预测后再应用。": "The current model changed. Predict again before applying the mesh.",
    "预测节点已应用，可在计算页求解验算。": "Predicted nodes applied. Solve on the analysis page to verify accuracy.",
    "正在从几何重新生成粗网格并提取参考尺寸标签。": "Generating coarse meshes from geometry and extracting reference size labels.",
    "该工况已存在，已跳过重复导入。": "This case already exists; duplicate import skipped.",
    "最新检查点无法读取，已恢复上一份完整检查点。": "The latest checkpoint could not be read; the previous complete checkpoint was restored.",
    "已加入新样本；当前轮结束后新样本将与旧样本一起参与训练。": "New samples added. They will join existing samples after the current epoch.",
    "当前检查点已保存。": "The current checkpoint is saved.",
    "检查点已保存。": "Checkpoint saved.",
    "已保存并暂停。": "Saved and paused.",
    "本次训练完成，检查点已保存。": "Training completed and checkpoint saved.",
    "已生成预测网格；需有限元求解后检查实际误差。": "Predicted mesh generated; verify the achieved error with a finite element solve.",
    "神经网络训练": "Neural Network Training",
    "从自适应网格学习节点分布 · 条件多尺度图神经网络": "Learn adaptive node distributions · Conditional multiscale graph network",
    "正在连接训练环境": "Connecting to the training environment",
    "优先连接上次使用的 PyTorch；首次连接或连接失败时自动自检，请稍候。": "Connecting to the last used PyTorch; the first connection or a failed connection triggers automatic checks. Please wait.",
    "已学习独立工况": "Unique cases learned",
    "训练集 0 · 验证集 0": "Training 0 · Validation 0",
    "累计学习次数": "Graph presentations",
    "每张粗网格每次参与训练计一次": "Each coarse graph counts once per presentation",
    "累计处理单元": "Elements processed",
    "优化步数 0": "Optimizer steps 0",
    "训练状态": "Training status",
    "未开始": "Not started",
    "已完成 0 轮": "Completed epochs 0",
    "训练控制": "Training controls",
    "任务名称": "Run name",
    "训练轮数": "Epochs",
    "学习率": "Learning rate",
    "隐藏特征维数": "Hidden width",
    "消息传递层数": "Message-passing layers",
    "自动保存间隔（秒）": "Autosave interval (s)",
    "开始新训练": "Start new run",
    "保存并暂停": "Save and pause",
    "保存检查点": "Save checkpoint",
    "恢复的训练记录": "Run to restore",
    "尚无记录": "No runs yet",
    "继续训练": "Resume training",
    "继续训练保留优化器和读取进度，可加入勾选的新工况。已完成的任务会追加上方设置的轮数。按设定间隔自动保存，暂停及完成时也会保存。": "Resume preserves optimizer and data position, and adds selected new cases. Completed runs receive the additional epochs configured above. Checkpoints save at the configured interval, on pause, and on completion.",
    "尚无检查点": "No checkpoint yet",
    "预测计算节点": "Predict analysis nodes",
    "使用选定检查点，为结构绘制页的当前模型预测节点。预测精度需通过有限元计算验证。": "Use the selected checkpoint to predict nodes for the current geometry. Verify accuracy with a finite element solve.",
    "节点预算": "Node budget",
    "预测当前模型节点": "Predict nodes for current model",
    "应用预测网格": "Apply predicted mesh",
    "下载预测 JSON": "Download prediction JSON",
    "学习曲线": "Learning curves",
    "等待训练": "Awaiting training",
    "● 训练损失": "● Training loss",
    "● 验证损失": "● Validation loss",
    "尚无验证集，不能评估泛化能力": "No validation set; generalization has not been evaluated",
    "训练数据": "Training data",
    "0 个工况": "0 cases",
    "样本用途": "Dataset split",
    "验证集": "Validation set",
    "更改学习用途": "Change learning split",
    "应用到勾选工况": "Apply to selected cases",
    "改为验证集": "Move to validation set",
    "改为训练集": "Move to training set",
    "正在更改学习用途…": "Changing learning split…",
    "可更改单个或勾选工况的用途，同一几何的其他工况会同步更改，无需重新导入。请先暂停训练和生成；继续训练时采用当前用途。已学过的数据改为验证集后，不能作为该模型的独立泛化验证。": "Change one or selected cases without reimporting; all cases sharing the geometry move together. Pause training and generation first. Resumed training uses the current splits. Previously learned data cannot independently validate the same model after being moved to validation.",
    "已按当前学习用途更新训练集与验证集。": "Training and validation sets updated to the current learning splits.",
    "训练集": "Training set",
    "验证集（使用不同几何）": "Validation set (different geometries)",
    "无 ZZ 记录时的参考误差": "Assumed error when ZZ history is absent",
    "导入模型 JSON": "Import model JSON",
    "加入当前自适应模型": "Add current adaptive model",
    "从本机路径导入大文件": "Import a large file by local path",
    "导入路径": "Import path",
    "每个工况自动生成三种几何粗网格。重复工况会跳过；同一几何的不同载荷不能跨训练集和验证集。未达到目标精度的参考网格按实际误差记录。": "Three geometry-only coarse meshes are generated per case. Duplicates are skipped. Load cases sharing geometry cannot cross splits. Unconverged reference meshes retain their achieved error.",
    "使用": "Use",
    "工况": "Case",
    "用途": "Split",
    "参考节点": "Reference nodes",
    "参考误差": "Reference error",
    "停止原因": "Stop reason",
    "尚无样本，请先导入自适应模型 JSON。": "No samples yet. Import an adaptive model JSON.",
    "训练记录": "Training log",
    "等待连接": "Awaiting connection",
    "网格尺寸学习": "Mesh sizing learning",
    "训练损失与验证损失曲线": "Training and validation loss curves",
    "完整 JSON 文件路径": "Absolute JSON file path",
    "训练中": "Training",
    "准备中": "Preparing",
    "正在保存并暂停": "Saving and pausing",
    "已暂停": "Paused",
    "训练停止": "Training stopped",
    "可恢复": "Recoverable",
    "无检查点": "No checkpoint",
    "验证工况独立于训练几何": "Validation cases use independent geometries",
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
    [/^标签对照：平均尺寸偏差因子 ([\d.]+) · 偏粗区域 (.+) · 偏细区域 (.+) · 基础网格损失 (.+)$/u, m => `Reference comparison: mean size deviation factor ${m[1]} · Coarser area ${m[2]} · Finer area ${m[3]} · Initial-mesh loss ${m[4]}`],
    [/^当前学习率 ([\deE.+-]+) · 训练几何 (\d+) · 验证几何 (\d+)( · 验证几何少于 3，诊断仅供参考。)?$/u, m => `Learning rate ${m[1]} · Training geometries ${m[2]} · Validation geometries ${m[3]}${m[4]?' · Fewer than 3 validation geometries; diagnostics are provisional.':''}`],
    [/^保存生成记录失败，进度已保留在当前程序中，请恢复文件访问后继续生成：([\s\S]+)$/u, m => `Failed to save generation progress. The current program retains it in memory; restore file access and resume: ${translateEnglishText(m[1])}`],
    [/^训练工况文件已删除或缺失，无法继续训练：(.+)$/u, m => `Training cannot resume because dataset files were deleted or are missing: ${m[1]}`],
    [/^无法恢复检查点：(.+)$/u, m => `Unable to restore a checkpoint: ${translateEnglishText(m[1])}`],
    [/^计算后端自检失败：(.+)$/u, m => `Compute backend check failed: ${translateEnglishText(m[1])}`],
    [/^(CUDA|ROCM|XPU|MPS|DirectML|cuda|rocm|xpu|mps|directml) 不可用$/u, m => `${m[1]} is unavailable`],
    [/^无效的 FEM_ML_DEVICE：(.+)$/u, m => `Invalid FEM_ML_DEVICE: ${m[1]}`],
    [/^生成参数 (\w+) 必须在 (.+) 范围内(且为整数)?。$/u, m => `Generation parameter ${m[1]} must be in the range ${m[2]}${m[3]?' and must be an integer':''}.`],
    [/^已永久删除 (\d+) 个训练工况的磁盘文件。$/u, m => `Permanently deleted files for ${m[1]} training cases.`],
    [/^(\d+) 个批次 · (\d+) 个历史工况(?: · (\d+) 个已分配)?$/u, m => `${m[1]} batches · ${m[2]} historical cases${m[3]===undefined?'':' · '+m[3]+' assigned'}`],
    [/^(\d+) 个批次 · (\d+) 个工况 · (\d+) 个文件 · ([\d.]+ MiB)$/u, m => `${m[1]} batches · ${m[2]} cases · ${m[3]} files · ${m[4]}`],
    [/^已删除 (\d+) 个历史工况、(\d+) 个完整批次。(.*)$/u, m => `Deleted ${m[1]} historical cases and ${m[2]} complete batches.${m[3]?' '+translateEnglishText(m[3]):''}`],
    [/^分配用途 (g\d+-c\d+)$/u, m => `Assign split for ${m[1]}`],
    [/^(永久删除所选工况的整个训练数据目录（参考模型、训练图和元数据）？文件无法恢复。原始导入 JSON 和生成批次文件保留。)(.+)$/u, m => `${translateEnglishText(m[1])} ${translateEnglishText(m[2])}`],
    [/^([\s\S]+)\n(\d+) 个文件 · (.+ MiB)$/u, m => `${m[1]}\n${m[2]} files · ${m[3]}`],
    [/^已勾选 (\d+) 个工况$/u, m => `${m[1]} cases selected`],
    [/^工况模型预览：(.+)$/u, m => `Case model preview: ${m[1]}`],
    [/^(参考网格|输入粗网格 \d+) · ([\d,]+) 节点$/u, m => `${translateEnglishText(m[1])} · ${m[2]} nodes`],
    [/^输入粗网格 (\d+)$/u, m => `Input coarse mesh ${m[1]}`],
    [/^(训练|验证) · 参考误差 (.+) · (.+) · ([\d,]+ 节点 \/ [\d,]+ 单元|几何、材料与载荷)( · 精度为人工假定值)?$/u, m => `${translateEnglishText(m[1])} · Reference error ${m[2]} · ${translateEnglishText(m[3])} · ${translateEnglishText(m[4])}${m[5]?' · Accuracy is user-assumed':''}`],
    [/^已永久删除 (\d+) 个训练工况。(.*)$/u, m => `Permanently deleted ${m[1]} training cases.${m[2]? ' '+translateEnglishText(m[2]):''}`],
    [/^被以下训练记录引用：(.+)。删除后将无法完整恢复原任务的数据与读取进度，或导出包含原数据的完整模型包；权重仍可预测，也可用于后续训练，但当前恢复入口要求原数据。(.*)$/u, m => `Referenced by: ${m[1]}. Deletion prevents exact recovery of the original data and cursor, or exporting a package containing that data. Weights remain usable for prediction and further training, but the current resume entry requires the original data.${m[2]?' '+translateEnglishText(m[2]):''}`],
    [/^预览失败：(.+)$/u,m=>`Preview failed: ${m[1]}`],
    [/^(.+) · (\d+)\/(\d+) · 已加入 (\d+) · 失败 (\d+)$/u, m => `${translateEnglishText(m[1])} · ${m[2]}/${m[3]} · Imported ${m[4]} · Failed ${m[5]}`],
    [/^已求解 (\d+)\/(\d+) · 精度达标 (\d+)\/(\d+) · 已分配 (\d+)(?: · 每参考计算小时达标 ([\d.]+))?$/u, m => `Solved ${m[1]}/${m[2]} · Target met ${m[3]}/${m[4]} · Assigned ${m[5]}${m[6]?' · Targets met per reference-compute hour '+m[6]:''}`],
    [/^热点补救 (\d+) 级 · 末次加密冻结误差 ([\d.]+)% · 预算重试 (\d+) 次$/u, m => `Hotspot rescue level ${m[1]} · Frozen error at last refinement ${m[2]}% · Budget retries ${m[3]}`],
    [/^批次(.+)：生成 (\d+)，加入训练 (\d+)，失败 (\d+)，未达标过滤 (\d+)。$/u, m => `Batch ${translateEnglishText(m[1])}: generated ${m[2]}, imported ${m[3]}, failed ${m[4]}, filtered by target ${m[5]}.`],
    [/^已更改 (\d+) 个工况的学习用途，同一几何的工况同步更改。$/u, m => `Changed the learning split for ${m[1]} cases; cases sharing geometry were updated together.`],
    [/^(.+) · (\d+) 个图形 · (\d+) 个区域 · (\d+) 个孔洞$/u, m => `${translateEnglishText(m[1])} · ${m[2]} primitives · ${m[3]} regions · ${m[4]} holes`],
    [/^随机模型 (.+) \/ G(\d+) \/ C(\d+)$/u, m => `Random model ${m[1]} / G${m[2]} / C${m[3]}`],
    [/^([\d,]+) 节点 \/ ([\d,]+) 单元$/u, m => `${m[1]} nodes / ${m[2]} elements`],
    [/^(生成几何|生成参考网格|有限元求解|ZZ 自适应加密|准备训练图) · (.+?)(?: · (\d+) 节点)?。已生成工况保存在本机，(停止|暂停)会等待当前工况完成。$/u, m => `${translateEnglishText(m[1])} · ${translateEnglishText(m[2])}${m[3]?' · '+m[3]+' nodes':''}. Completed cases are saved locally; ${m[4]==='暂停'?'pausing':'stopping'} waits for the current case.`],
    [/^([\d.]+ MiB)((?: · (?:最新|最佳验证|不可读取))+)$/u, (m) => m[1]+m[2].replace(/最新/gu,'Latest').replace(/最佳验证/gu,'Best validation').replace(/不可读取/gu,'Unreadable')],
    [/^(.+\.pt · [\d,]+ \/ [\d,]+) · 不可读取$/u, (m) => `${m[1]} · Unreadable`],
    [/^(.+) · (\d+) 轮 · (.+)$/u, (m) => `${m[1]} · ${m[2]} epochs · ${translateEnglishText(m[3])}`],
    [/^(.+ · .+) · (生成中|已完成|已停止|已暂停|完成当前工况后暂停|已中断|失败)$/u, m => `${m[1]} · ${translateEnglishText(m[2])}`],
    [/^(\d+) 种粗网格(?: · (.+))?$/u, (m) => `${m[1]} coarse meshes${m[2] ? ' · '+translateEnglishText(m[2]) : ''}`],
    [/^选择 (.+)$/u, (m) => `Select ${m[1]}`],
    [/^已完成 (\d+) 轮$/u, (m) => `Completed ${m[1]} epochs`],
    [/^训练服务连接失败：(.+)$/u, (m) => `Training service connection failed: ${translateEnglishText(m[1])}`],
    [/^训练服务已退出：(.+)$/u, (m) => `Training service exited: ${translateEnglishText(m[1])}`],
    [/^训练已在 (.+) 上开始。$/u, (m) => `Training started on ${m[1]}.`],
    [/^已导入 (.+)：1 个工况，(\d+) 张独立粗网格。$/u, (m) => `Imported ${m[1]}: 1 case, ${m[2]} independent coarse meshes.`],
    [/^训练停止：(.+)；可恢复最近完整检查点。$/u, (m) => `Training stopped: ${translateEnglishText(m[1])}; restore the latest complete checkpoint to resume.`],
    [/^(.*?) 夜间保护：运行恢复 (\d+)\/2 次 · 防休眠(已启用|未启用)$/u, m => `${translateEnglishText(m[1])} Overnight protection: runtime recoveries ${m[2]}/2 · Idle-sleep prevention ${m[3]==='已启用'?'enabled':'inactive'}`],
    [/^(.+) 自动恢复 (\d+)\/(\d+) 次 · 权重衰减 ([\deE.+-]+) · Dropout ([\d.]+)$/u, m => `${translateEnglishText(m[1])} Automatic recoveries ${m[2]}/${m[3]} · Weight decay ${m[4]} · Dropout ${m[5]}`],
    [/^(已生成 [\s\S]+尚未进行误差验算。) 推理设备：(.+) \(([^)]+)\)；总耗时 ([\d.]+) 秒，其中神经网络 ([\d.]+) 秒、图构建 ([\d.]+) 秒、基础网格 ([\d.]+) 秒、细化 ([\d.]+) 秒。$/u, m => `${translateEnglishText(m[1])} Inference device: ${m[2]} (${m[3]}); total ${m[4]} s, network ${m[5]} s, graph construction ${m[6]} s, seed mesh ${m[7]} s, refinement ${m[8]} s.`],
    [/^已生成 ([\d,]+) 个节点、([\d,]+) 个单元。(.*?)尚未进行误差验算。$/u, (m) => `Generated ${m[1]} nodes and ${m[2]} elements. ${m[3] ? translateEnglishText(m[3])+' ' : ''}Accuracy has not been verified.`],
    [/^训练集 (\d+) · 验证集 (\d+)$/u, (m) => `Training ${m[1]} · Validation ${m[2]}`],
    [/^优化步数 ([\d,]+)$/u, (m) => `Optimizer steps ${m[1]}`],
    [/^已完成 (\d+) \/ (\d+) 轮$/u, (m) => `Completed ${m[1]} / ${m[2]} epochs`],
    [/^(\d+) 个独立工况$/u, (m) => `${m[1]} unique cases`],
    [/^训练 (.+) · 验证 (.+)$/u, (m) => `Training ${m[1]} · Validation ${m[2]}`],
    [/^第 (\d+) 轮$/u, (m) => `Epoch ${m[1]}`],
    [/^已保存第 (\d+) 步 · (.+)$/u, (m) => `Saved step ${m[1]} · ${m[2]}`],
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

  // Keep source and rendered values together. A translated message can still
  // contain Chinese user names, filenames, or an unknown backend error. Never
  // feed our own rendered value back through translation as a new source.
  function localizedRecord(current, known) {
    if (known && (current === known.source || current === known.rendered)) return known;
    if (activeLanguage !== "en" || !HAN_TEXT.test(current)) return null;
    return { source: current, rendered: translateEnglishText(current) };
  }

  function translateTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parentTag = node.parentElement?.tagName;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parentTag)) return;
    const current = node.data;
    const record = localizedRecord(current, sourceTextByNode.get(node));
    if (!record) { sourceTextByNode.delete(node); return; }
    sourceTextByNode.set(node, record);
    const desired = activeLanguage === "en" ? record.rendered : record.source;
    if (current !== desired) node.data = desired;
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
    const sources = attributeSources(element);
    if (!element?.hasAttribute?.(attributeName)) { sources.delete(attributeName); return; }
    const current = element.getAttribute(attributeName) || "";
    const record = localizedRecord(current, sources.get(attributeName));
    if (!record) { sources.delete(attributeName); return; }
    sources.set(attributeName, record);
    const desired = activeLanguage === "en" ? record.rendered : record.source;
    if (current !== desired) element.setAttribute(attributeName, desired);
  }

  function translateInitialValue(element) {
    if (!(element instanceof HTMLInputElement) || !element.hasAttribute("value")) return;
    const current = element.value;
    const record = localizedRecord(current, sourceValueByElement.get(element));
    if (!record) { sourceValueByElement.delete(element); return; }
    sourceValueByElement.set(element, record);
    const desired = activeLanguage === "en" ? record.rendered : record.source;
    if (current !== desired) element.value = desired;
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
      const textNodes = new Set(), attributes = new Map(), addedRoots = new Set();
      for (const record of records) {
        if (record.type === "characterData") textNodes.add(record.target);
        else if (record.type === "attributes") {
          if (!attributes.has(record.target)) attributes.set(record.target, new Set());
          attributes.get(record.target).add(record.attributeName);
        } else record.addedNodes.forEach(node => addedRoots.add(node));
      }
      addedRoots.forEach(translateTree);
      textNodes.forEach(translateTextNode);
      attributes.forEach((names, element) => names.forEach(name => translateAttribute(element, name)));
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
    // Only refresh the visible workspace. Hidden finite element views may contain
    // large meshes and do not need to be rebuilt for a dashboard language change.
    if (typeof window.currentPageKey === "function") {
      const page = window.currentPageKey();
      const byPage = {
        home: ["updatePanel", "render"],
        calculation: ["updateCalculationPanel", "renderCalculationView"],
        results: ["renderResultView"],
        materials: ["renderMaterialLibrary"],
        training: [],
      };
      if (Object.hasOwn(byPage, page)) {
        byPage[page].forEach((name) => {
          if (typeof window[name] === "function") window[name]();
        });
        return;
      }
    }
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
