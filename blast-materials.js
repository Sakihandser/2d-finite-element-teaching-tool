// Constitutive cards use SI units throughout. Shared by the browser and runner.
(function(root){
  const names=['拉伸损伤（裂带）','线弹性','Drucker–Prager + 拉伸损伤','JH2'];
  const fields={
    jh2:[['A','完整强度 A',1],['N','完整强度指数 N',1],['B','破碎强度 B',1],['M','破碎强度指数 M',1],
      ['C','应变率系数 C',1],['rate0','参考应变率 (1/s)',1],['HEL','HEL 纵向应力 (GPa)',1e9],['pHEL','HEL 压力 (GPa)',1e9],
      ['T','静水拉伸强度 T (MPa)',1e6],['D1','损伤系数 D1',1],['D2','损伤指数 D2',1],['maxStrength','归一化破碎强度上限',1],
      ['K1','EOS K1 (GPa)',1e9],['K2','EOS K2 (GPa)',1e9],['K3','EOS K3 (GPa)',1e9],['beta','膨胀能量比例 β (0–1)',1],
      ['referenceLength','损伤参考长度 (mm，0 不作长度修正)',.001],['normalizationStress','归一化等效应力 σHEL (GPa，0 由 HEL 换算)',1e9]],
    dp:[['friction','摩擦角 (°)',1],['dilation','剪胀角 (°)',1]]
  };
  function normalize(raw){
    if(!raw || typeof raw!=='object' || Array.isArray(raw))return null;
    const out={law:raw.law??-1};
    if(![-1,0,1,2,3].includes(out.law))throw new Error('Invalid constitutive law.');
    for(const type of ['jh2','dp'])if(raw[type]){out[type]={};for(const [key] of fields[type]){
      const value=raw[type][key];if(value!==undefined && value!==null && value!==''){
        if(typeof value!=='number' || !Number.isFinite(value))throw new Error(`Invalid ${type} parameter: ${key}`);
        out[type][key]=value;
      }
    }}
    return out;
  }
  function law(material,settings){return material.blastConstitutive?.law>=0 ? material.blastConstitutive.law : settings.rockModel??0;}
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
    return {model,card};
  }
  // Fixed numeric sidecar: no change to the static solver's binary protocol.
  function rows(model,settings){
    return (model.materials||[]).map(m=>{
      const {model:which,card}=validate(m,settings),j=card?.jh2||{},d=card?.dp||{};
      return [m.materialNo,which,...fields.jh2.map(([k])=>j[k]??0),d.friction??0,d.dilation??0].join(' ');
    }).join('\n')+'\n';
  }
  const api={names,fields,normalize,law,validate,rows};
  if(typeof module!=='undefined' && module.exports)module.exports=api;else root.BlastMaterials=api;
})(typeof window!=='undefined'?window:globalThis);
