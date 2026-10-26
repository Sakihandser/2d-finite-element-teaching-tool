// Shared SI EOS registry and preflight. Native equations: GasConstitutive.h.
(function(root){
  const names={0:'理想气体',1:'JWL（使用标定系数）',2:'常规参数（密度、爆速、爆热）',3:'Noble–Abel 气体',4:'刚性气体 (Stiffened Gas)',5:'Noble–Abel 刚性气体 (NASG)',6:'van der Waals 气体（单相高温）'};
  const ids=[0,3,4,5,6],extraKeys=['Covolume','PressureOffset','EnergyShift','Attraction'];
  const help={
    0:'理想气体采用常比热比，不含分子排斥、吸引或相变。',
    1:'JWL 用于已经反应的爆轰产物，需要独立标定的系数和内能；不计算爆轰反应前沿。',
    2:'等效 CJ 为理想产物近似，不能替代高密度炸药的标定 JWL，也不计算反应前沿。',
    3:'Noble–Abel 用余容积描述稠密气体排斥；必须满足 bρ < 1，且内能大于参考能量 q；不含相变。',
    4:'刚性气体用压力偏移模拟可压缩介质，是常比热的经验近似；需独立标定，不能直接当作真实气体物性。',
    5:'NASG 同时考虑余容积和压力偏移；要求 bρ < 1、正压力和正声速平方；不含相变。',
    6:'van der Waals 仅支持高于临界温度的稳定单相区和常定容比热；不求相平衡，接近临界区或进入非双曲区会停止。'
  };
  function active(key,model){if(key==='EnergyShift')return model>=3;if(key==='Covolume')return [3,5,6].includes(model);if(key==='PressureOffset')return [4,5].includes(model);if(key==='Attraction')return model===6;return true;}
  function card(settings,prefix){const product=prefix==='product';return {model:settings[product?'productEOS':'airEOS']??0,gamma:settings[product?'productGamma':'airGamma'],b:settings[prefix+'Covolume']??0,pinf:settings[prefix+'PressureOffset']??0,q:settings[prefix+'EnergyShift']??0,a:settings[prefix+'Attraction']??0};}
  function evaluate(c,rho,energy){
    const d=1-c.b*rho,u=energy-c.q;
    if(!(rho>0&&energy>0&&Number.isFinite(energy)&&d>0))throw new Error('气体密度和内能必须为正，并满足 bρ < 1。');
    if(c.model===6){
      const thermal=u+c.a*rho,p=(c.gamma-1)*rho*thermal/d-c.a*rho*rho,c2=c.gamma*(p+c.a*rho*rho)/(rho*d)-2*c.a*rho;
      const stable=(c.gamma-1)*thermal/(d*d)-2*c.a*rho;
      if(!(thermal>0 && thermal>8*c.a/(27*(c.gamma-1)*c.b) && stable>0 && p>0 && c2>0 && Number.isFinite(p+c2)))throw new Error('van der Waals 状态必须位于高于临界温度的正压力、稳定单相区。请调整密度、内能或更换 EOS。');
      return {pressure:p,soundSpeedSquared:c2};
    }
    const p=(c.gamma-1)*rho*u/d-c.gamma*c.pinf,c2=c.gamma*(p+c.pinf)/(rho*d);
    if(!(u>0&&p>0&&c2>0&&Number.isFinite(p+c2)))throw new Error('气体 EOS 必须保持内能大于 q、正压力和正声速平方。请调整参数或更换 EOS。');
    return {pressure:p,soundSpeedSquared:c2};
  }
  function energyFromPressure(c,rho,pressure){const d=1-c.b*rho;return c.model===6?c.q+(pressure+c.a*rho*rho)*d/((c.gamma-1)*rho)-c.a*rho:c.q+(pressure+c.gamma*c.pinf)*d/((c.gamma-1)*rho);}
  function constraints(settings){
    const errors=[],warnings=[];if(settings.sourceMode!==1)return {errors,warnings};
    for(const prefix of ['product','air']){
      const c=card(settings,prefix),label=prefix==='product'?'爆轰产物':'间隙气体';if(c.model<3)continue;
      try{
        for(const key of extraKeys)if(!active(key,c.model))c[({Covolume:'b',PressureOffset:'pinf',EnergyShift:'q',Attraction:'a'})[key]]=0;
        if(!ids.includes(c.model)||!(c.gamma>1&&c.gamma<=10)||!Number.isFinite(c.b+c.pinf+c.q+c.a)||c.q<0||c.b<0||c.pinf<0||c.a<0)throw new Error('非理想气体参数必须有限，比热比大于 1，余容积、压力偏移、参考能量和吸引系数非负。');
        if([3,5,6].includes(c.model)&&!(c.b>0))throw new Error('该 EOS 需要大于 0 的余容积 b。');
        if([4,5].includes(c.model)&&!(c.pinf>0))throw new Error('该 EOS 需要大于 0 的压力偏移 p∞。');
        if(c.model===6&&!(c.a>0))throw new Error('van der Waals 需要大于 0 的吸引系数 a。');
        const rho=settings[prefix==='product'?'productDensity':'airDensity'],energy=prefix==='product'?settings.productEnergy:energyFromPressure(c,rho,settings.airPressure);
        evaluate(c,rho,energy);
      }catch(error){errors.push({scope:label,model:c.model,message:error.message});}
    }
    const gap=!(settings.chargeRadius>=settings.radius*(1-1e-8));
    if(settings.ventEnds>0&&(settings.productEOS>=3||(gap&&settings.airEOS>=3)))errors.push({scope:'气体耦合',message:'非理想气体暂不支持当前轴向泄流公式。请选择两端封堵，或改用理想气体 / JWL。'});
    if(settings.productEOS>=3||settings.airEOS>=3)warnings.push('非理想气体使用通用 HLLC 通量；强膨胀返回采用局部多方近似。需检查网格和时间步收敛，不包含反应或相变。');
    return {errors,warnings};
  }
  const api={names,ids,extraKeys,help,active,card,evaluate,energyFromPressure,constraints};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.GasEOS=api;
})(typeof window!=='undefined'?window:globalThis);
