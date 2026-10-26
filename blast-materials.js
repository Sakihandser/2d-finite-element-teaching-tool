// Constitutive cards use SI units throughout. Shared by the browser and runner.
(function(root){
  // Stable IDs: never reorder saved model selections. Field order is the SOLID1 sidecar ABI.
  const names=['拉伸损伤（裂带）','线弹性','Drucker–Prager + 拉伸损伤','JH2',
    'J2 / Von Mises 弹塑性','Johnson–Cook (JC)','Mohr–Coulomb (MC)',
    '广义 Maxwell / Prony 黏弹性','Neo-Hookean 超弹性','Modified Cam-Clay（常弹性）',
    'DP-Cap（椭圆帽盖）','J2 / Perzyna 黏塑性','正交各向异性弹性','Mooney–Rivlin 超弹性','HJC 混凝土（连续压实）'];
  const groups=[null,null,'dp','jh2','j2','jc','mc','maxwell','neoHookean','mcc','cap','perzyna','orthotropic','mooneyRivlin','hjc'];
  const fields={
    jh2:[['A','完整强度 A',1],['N','完整强度指数 N',1],['B','破碎强度 B',1],['M','破碎强度指数 M',1],
      ['C','应变率系数 C',1],['rate0','参考应变率 (1/s)',1],['HEL','HEL 纵向应力 (GPa)',1e9],['pHEL','HEL 压力 (GPa)',1e9],
      ['T','静水拉伸强度 T (MPa)',1e6],['D1','损伤系数 D1',1],['D2','损伤指数 D2',1],['maxStrength','归一化破碎强度上限',1],
      ['K1','EOS K1 (GPa)',1e9],['K2','EOS K2 (GPa)',1e9],['K3','EOS K3 (GPa)',1e9],['beta','膨胀能量比例 β (0–1)',1],
      ['referenceLength','损伤参考长度 (mm，0 不作长度修正)',.001],['normalizationStress','归一化等效应力 σHEL (GPa，0 由 HEL 换算)',1e9]],
    dp:[['friction','摩擦角 (°)',1],['dilation','剪胀角 (°)',1]],
    j2:[['yield','初始屈服应力 (MPa)',1e6],['hardening','等向硬化模量 H (MPa)',1e6]],
    jc:[['A','初始屈服 A (MPa)',1e6],['B','硬化系数 B (MPa)',1e6],['n','硬化指数 n',1],['C','应变率系数 C',1],['rate0','参考塑性应变率 (1/s)',1],['m','热软化指数 m',1],['referenceTemperature','参考温度 (K)',1],['meltTemperature','熔化温度 (K)',1],['initialTemperature','初始温度 (K)',1],['heatCapacity','比热 (J/kg/K)',1],['heatFraction','塑性功转热比例 (0–1)',1]],
    mc:[['cohesion','黏聚力 (MPa)',1e6],['friction','摩擦角 (°)',1],['dilation','剪胀角 (°)',1],['tension','拉伸截断强度 (MPa)',1e6]],
    maxwell:Array.from({length:4},(_,i)=>[[`g${i+1}`,`Prony g${i+1}（未用填 0）`,1],[`tau${i+1}`,`Prony τ${i+1} (ms，未用填 0)`,.001]]).flat(),
    neoHookean:[['shear','剪切模量 G (MPa)',1e6],['bulk','体积模量 K (MPa)',1e6]],
    mcc:[['M','临界状态斜率 M',1],['lambda','压缩指数 λ',1],['kappa','回弹指数 κ',1],['voidRatio','初始孔隙比 e₀',1],['pc','初始预固结压力 pc (MPa)',1e6]],
    cap:[['cohesion','DP 截距 d (MPa)',1e6],['friction','DP 摩擦角 β (°)',1],['dilation','DP 剪胀角 (°)',1],['pressure','初始帽盖中心 pa (MPa)',1e6],['aspect','帽盖长宽比 R',1],['hardening','压实硬化模量 (MPa)',1e6]],
    perzyna:[['yield','初始屈服应力 (MPa)',1e6],['hardening','等向硬化模量 H (MPa)',1e6],['time','黏塑性时间尺度 (ms)',.001],['exponent','过应力指数 n',1]],
    orthotropic:[['E1','E₁ (GPa)',1e9],['E2','E₂ (GPa)',1e9],['E3','E₃ (GPa)',1e9],['nu12','ν₁₂',1],['nu23','ν₂₃',1],['nu13','ν₁₃',1],['G12','G₁₂ (GPa)',1e9],['G23','G₂₃ (GPa)',1e9],['G13','G₁₃ (GPa)',1e9],['angle','材料 1 轴方向 (°)',1]],
    mooneyRivlin:[['C10','C₁₀ (MPa)',1e6],['C01','C₀₁ (MPa)',1e6],['bulk','体积模量 K (MPa)',1e6]],
    hjc:[['A','黏聚强度 A',1],['B','压力强化 B',1],['N','压力指数 N',1],['C','应变率系数 C',1],['rate0','参考应变率 (1/s)',1],['fc','归一化抗压强度 fc (MPa)',1e6],['T','静水拉伸强度 T (MPa)',1e6],['maxStrength','归一化强度上限',1],['D1','损伤系数 D1',1],['D2','损伤指数 D2',1],['minFailureStrain','最小破坏应变',1],['crushPressure','压碎压力 (MPa)',1e6],['crushVolume','压碎体积压缩 μc',1],['lockPressure','锁定压力 (MPa)',1e6],['lockVolume','锁定体积压缩 μl',1],['K1','密实体积模量 K1 (GPa)',1e9],['K2','密实 EOS K2 (GPa)',1e9],['K3','密实 EOS K3 (GPa)',1e9]]
  };
  const help=[
    '裂带拉伸软化描述张拉开裂；需要实测单轴抗拉强度和断裂能。',
    '线弹性用于检查波传播和加载，不产生损伤或塑性耗能。',
    'DP 描述压力相关剪切屈服，并叠加拉伸软化；需要实测单轴强度、摩擦角和剪胀角。',
    'JH2 用于爆破等高速载荷，计算压力相关强度、应变率、塑性损伤和破碎剩余强度。T 为静水拉伸强度。',
    'J2：三维径向返回与线性等向硬化，适用于金属屈服；不含断裂。',
    'JC：塑性应变率强化、等向硬化及绝热升温软化；不含 JC 断裂和热传导。',
    'MC：主应力空间多屈服面返回，包含棱边、顶点、非关联剪胀和拉伸截断。',
    'Prony：瞬时 E、ν 来自基础材料，体积弹性不松弛；最多四个剪切松弛支路，Σg < 1。',
    'Neo-Hookean：等容剪切能与 K(J−1)²/2 体积能；须使用有限变形和平面应变。',
    'MCC：常弹性变体，E、ν 来自基础材料；关联流动及预固结硬化，须先施加正有效围压，不包含孔隙水求解。',
    'DP-Cap：DP 剪切面与连续椭圆压缩帽盖、非关联剪胀和线性压实硬化；不是商业求解器的全部 Cap 选项。',
    'Perzyna：隐式过应力积分、线性等向硬化；时间尺度越小越接近率无关 J2。',
    '正交各向异性：九个独立弹性常数和面内材料方向，要求柔度矩阵正定；当前使用小变形。',
    'Mooney–Rivlin：C₁₀(Ī₁−3)+C₀₁(Ī₂−3)+K(J−1)²/2；须使用有限变形和平面应变。',
    'HJC：压力和应变率强化、塑性损伤及不可逆体积压实；采用连续三段压实 EOS，无单元侵蚀。'
  ];
  function normalize(raw){
    if(!raw || typeof raw!=='object' || Array.isArray(raw))return null;
    const out={law:raw.law??-1};
    if(!Number.isInteger(out.law) || out.law < -1 || out.law>=names.length)throw new Error('Invalid constitutive law.');
    for(const type of Object.keys(fields))if(raw[type]){out[type]={};for(const [key] of fields[type]){
      const value=raw[type][key];if(value!==undefined && value!==null && value!==''){
        if(typeof value!=='number' || !Number.isFinite(value))throw new Error(`Invalid ${type} parameter: ${key}`);
        out[type][key]=value;
      }
    }}
    return out;
  }
  function law(material,settings){return material.blastConstitutive?.law>=0 ? material.blastConstitutive.law : settings.rockModel??0;}
  // Configuration constraints are separate from measured-parameter validation:
  // the editor can report them even while a material card is incomplete.
  function compatibility(material={},settings={}){
    const model=law(material,settings),errors=[],warnings=[];
    if(settings.kinematics===1 && settings.planeMode!==1)errors.push('有限变形无法使用平面应力。请将二维假设改为平面应变，或将运动学改为小变形。');
    if(model===8 || model===13){
      if(settings.planeMode!==1)errors.push('该超弹性本构无法使用平面应力。请改为平面应变，或更换固体本构。');
      if(settings.kinematics!==1)errors.push('该超弹性本构需要有限变形。请更换运动学条件，或更换固体本构。');
    }
    if([7,9,12].includes(model) && settings.kinematics===1)errors.push('该本构目前只支持小变形。请将运动学改为小变形，或更换固体本构。');
    if(model===9){
      if(settings.loadMode===1)errors.push('MCC 不能从零初始应力突然加载。请选择先静力平衡，并施加正有效围压，或更换本构。');
      else if(!(settings.confineX>0||settings.confineY>0||settings.hasExternalLoads))errors.push('MCC 尚未设置正有效围压或压缩外载荷。请设置初始压缩条件，或更换本构。');
      else warnings.push('MCC 需要正初始有效围压，初始应力须在屈服面内；没有孔隙水求解，不能模拟拉伸状态。');
    }
    const initialLoad=(settings.confineX>0 || settings.confineY>0 || settings.hasExternalLoads || (settings.sourceMode===1 && settings.airPressure>0));
    if([8,13,14].includes(model) && settings.loadMode===0 && initialLoad)errors.push('该本构尚不支持非零预载的非线性静力初始化。请选择起爆时突然施加外载荷，或更换本构。');
    return {model,errors,warnings};
  }
  function validate(material,settings){
    const card=normalize(material.blastConstitutive),model=law({...material,blastConstitutive:card},settings),prefix=material.name||`#${material.materialNo}`;
    if(model===2){
      const d=card?.dp;
      if(!(material.compressiveStrength>0 && material.tensileStrength>0 && d && d.friction>=0 && d.friction<60 && d.dilation>=0 && d.dilation<=d.friction))
        throw new Error(`${prefix}: DP requires measured positive uniaxial compression/tension strengths, 0 <= dilation <= friction < 60 degrees.`);
    }
    if(model===3){
      const j=card?.jh2;
      if(!j || fields.jh2.some(([key])=>!Number.isFinite(j[key])))throw new Error(`${prefix}: complete the JH2 material card (SI units).`);
      if(!(j.A>0 && j.B>=0 && j.N>0 && j.M>0 && j.C>=0 && j.rate0>0 && j.HEL>j.pHEL && j.pHEL>0 && j.T>0 && j.D1>0 && j.D2>=0 && j.maxStrength>=0 && j.K1>0 && j.beta>=0 && j.beta<=1 && j.referenceLength>=0 && j.normalizationStress>=0))throw new Error(`${prefix}: invalid JH2 material card.`);
      // Require positive EOS tangent for every nonnegative compression, including
      // the minimum of the quadratic tangent (negative K2 is valid).
      if(j.K3<0 || (j.K3===0 && j.K2<0) || (j.K2<0 && j.K1-j.K2*j.K2/(3*j.K3)<=0))throw new Error(`${prefix}: JH2 EOS has a nonpositive compression tangent.`);
    }
    if(model>=4){
      const group=groups[model],v=card?.[group],fail=message=>{throw new Error(`${prefix}: ${names[model]} — ${message}`);};
      if(!v || fields[group].some(([k])=>!Number.isFinite(v[k])))fail('请完整填写材料卡（含所有零值），单位见字段标签。');
      const positive=(...ks)=>ks.every(k=>v[k]>0),nonnegative=(...ks)=>ks.every(k=>v[k]>=0);
      let valid=true;
      if(model===4 || model===11)valid=positive('yield')&&nonnegative('hardening')&&(model===4 || positive('time','exponent'));
      if(model===5)valid=positive('A','n','rate0','m','referenceTemperature','heatCapacity')&&nonnegative('B','C')&&v.meltTemperature>v.referenceTemperature&&v.initialTemperature>=v.referenceTemperature&&v.initialTemperature<v.meltTemperature&&v.heatFraction>=0&&v.heatFraction<=1;
      if(model===6)valid=nonnegative('cohesion','tension')&&v.friction>=0&&v.friction<89&&v.dilation>=0&&v.dilation<=v.friction&&(v.friction===0 || v.tension<=v.cohesion/Math.tan(v.friction*Math.PI/180));
      if(model===7){let sum=0;for(let i=1;i<=4;i++){valid &&=v[`g${i}`]>=0&&v[`tau${i}`]>=0&&(v[`g${i}`]===0||v[`tau${i}`]>0);sum+=v[`g${i}`];}valid &&=sum>0&&sum<1;}
      if(model===8)valid=positive('shear','bulk');
      if(model===9)valid=positive('M','lambda','kappa','pc')&&v.lambda>v.kappa&&v.voidRatio>0;
      if(model===10)valid=positive('cohesion','pressure','aspect')&&nonnegative('hardening')&&v.friction>=0&&v.friction<80&&v.dilation>=0&&v.dilation<=v.friction;
      if(model===12){
        valid=positive('E1','E2','E3','G12','G23','G13');
        const a=1/v.E1,b=1/v.E2,c=1/v.E3,d=-v.nu12/v.E1,e=-v.nu13/v.E1,f=-v.nu23/v.E2;
        valid &&=a*b-d*d>0 && a*b*c+2*d*e*f-a*f*f-b*e*e-c*d*d>0;
      }
      if(model===13)valid=nonnegative('C10','C01')&&v.C10+v.C01>0&&positive('bulk');
      if(model===14)valid=positive('A','N','rate0','fc','T','maxStrength','D1','minFailureStrain','crushPressure','crushVolume','K1')&&nonnegative('B','C','D2')&&v.lockPressure>v.crushPressure&&v.lockVolume>v.crushVolume&&(v.lockPressure-v.crushPressure)/(v.lockVolume-v.crushVolume)<v.crushPressure/v.crushVolume&&v.K3>=0&&(v.K3>0||v.K2>=0)&&(v.K2>=0||v.K1-v.K2*v.K2/(3*v.K3)>0)&&v.K1>=v.crushPressure/v.crushVolume;
      if(!valid)fail('参数范围或弹性正定性无效，请查阅 docs/SOLID_CONSTITUTIVE.md。');
      if((model===8||model===13)&&(settings.kinematics!==1||settings.planeMode!==1))fail('超弹性须选择有限变形和平面应变。');
      if((model===7||model===9||model===12)&&settings.kinematics===1)fail('此模型当前须选择小变形。');
    }
    return {model,card};
  }
  // Fixed numeric sidecar: no change to the static solver's binary protocol.
  function rows(model,settings){
    return (model.materials||[]).map(m=>{
      const {model:which,card}=validate(m,settings),j=card?.jh2||{},d=card?.dp||{};
      const row=[m.materialNo,which,...fields.jh2.map(([k])=>j[k]??0),d.friction??0,d.dilation??0];
      if(which>=4)row.push('SOLID1',...fields[groups[which]].map(([k])=>card[groups[which]][k]));
      return row.join(' ');
    }).join('\n')+'\n';
  }
  const api={names,groups,help,fields,normalize,law,compatibility,validate,rows};
  if(typeof module!=='undefined' && module.exports)module.exports=api;else root.BlastMaterials=api;
})(typeof window!=='undefined'?window:globalThis);
