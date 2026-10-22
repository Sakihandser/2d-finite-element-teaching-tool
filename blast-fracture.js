// Shared preflight for the native crack-band tensile-damage law. All values SI.
(function(root,factory){if(typeof module==="object" && module.exports)module.exports=factory();else root.BlastFracture=factory();})(typeof globalThis!=="undefined"?globalThis:this,function(){
  function inspect(model,settings){
    if(!settings.fracture)return {valid:true,materials:[],incompatibleElements:[]};
    const nodes=new Map((model.nodes || []).map(n=>[n.nodeNo,n]));
    const materials=new Map((model.materials || []).map(m=>[m.materialNo,m]));
    const groups=new Map(),incompatibleElements=[];
    for(const e of model.elements || []){
      const key=e.materialNo || 0,material=materials.get(key);
      const law=e.constitutiveLaw??(material?.blastConstitutive?.law>=0 ? material.blastConstitutive.law : settings.rockModel??0);
      if(law===1 || law===3)continue;
      if(!groups.has(key))groups.set(key,{materialNo:key,name:material?.name || `#${key}`,missingStrength:0,incompatible:0,minGf:0,criticalElement:null});
      const group=groups.get(key),ft=e.tensileStrength,E=e.elasticModulus;
      if(!(Number.isFinite(ft) && ft>0)){group.missingStrength++;continue;}
      const [a,b,c]=[e.node1,e.node2,e.node3].map(id=>nodes.get(id));
      if(!a || !b || !c || !(E>0 && Number.isFinite(E)))continue; // Native geometry/material validation remains authoritative.
      const h=Math.sqrt(Math.abs((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y)));
      const minGf=h*ft*ft/(2*E);
      if(minGf>group.minGf){group.minGf=minGf;group.criticalElement=e.elementNo;}
      if(!(settings.gf>minGf)){group.incompatible++;incompatibleElements.push(e.elementNo);}
    }
    const list=[...groups.values()];return {valid:list.every(m=>!m.missingStrength && !m.incompatible),materials:list,incompatibleElements};
  }
  function assertValid(model,settings){
    const report=inspect(model,settings);if(report.valid)return report;
    const missing=report.materials.filter(m=>m.missingStrength);
    if(missing.length)throw new Error(`Damage requires positive tensile strength (MPa in the material library): ${missing.map(m=>m.name).join(', ')}.`);
    const bad=report.materials.filter(m=>m.incompatible),required=Math.max(...bad.map(m=>m.minGf));
    throw new Error(`Damage mesh/energy mismatch: Gf must exceed ${required.toPrecision(8)} J/m^2; current ${settings.gf}. Refine the mesh or use a calibrated Gf. Critical element ${bad.find(m=>m.minGf===required).criticalElement}.`);
  }
  return {inspect,assertValid};
});
