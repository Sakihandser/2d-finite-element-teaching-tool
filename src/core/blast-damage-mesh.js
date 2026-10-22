// Geometry-only crack-band preparation. Strength and Gf always remain inputs.
(function(root,factory){
  if(typeof module==="object" && module.exports)module.exports=factory(require('../../blast-fracture'),require('./adaptive-mesh').refineAdaptiveTriangles);
  else root.BlastDamageMesh=factory(root.BlastFracture,refineAdaptiveTriangles);
})(typeof globalThis!=="undefined"?globalThis:this,function(Fracture,refine){
  function prepare(nodes,elements,properties,settings,options={}){
    const maxNodes=options.maxNodes ?? 250000,maxElements=options.maxElements ?? 500000,maxRounds=options.maxRounds ?? 16;
    const props=new Map(properties.map(p=>[String(p.id),p]));
    // Some older exports oriented edge node IDs without reversing tRange.
    // The placement sample chain is authoritative for the original endpoints.
    const parameters=new Map((options.boundarySegments || []).map(s=>[s.curveId,new Map((s.samples || []).map(p=>[String(p.nodeId),p.t]))]));
    let mesh={analysisNodes:nodes,elements:elements.map(e=>({...e,damageSourceId:String(e.id),edges:(e.edges || []).map(edge=>{
      const params=parameters.get(edge.curveId);
      return edge.boundary && params && edge.nodeIds.every(id=>params.has(String(id)))
        ? {...edge,tRange:edge.nodeIds.map(id=>params.get(String(id)))} : edge;
    })}))},rounds=0;
    for(;;){
      const model={nodes:mesh.analysisNodes.map(n=>({nodeNo:String(n.id),x:n.x,y:n.y})),elements:mesh.elements.map(e=>{
        const p=props.get(e.damageSourceId),ids=(e.analysisNodeIds || e.nodeIds).map(String);
        if(!p)throw new Error('损伤网格缺少材料数据。');
        return {elementNo:String(e.id),node1:ids[0],node2:ids[1],node3:ids[2],elasticModulus:p.elasticModulus,tensileStrength:p.tensileStrength,constitutiveLaw:p.constitutiveLaw};
      })};
      const report=Fracture.inspect(model,settings);
      if(report.valid)return {analysisNodes:mesh.analysisNodes,elements:mesh.elements.map(({damageSourceId,...e})=>e),rounds};
      if(report.materials.some(m=>m.missingStrength))Fracture.assertValid(model,settings);
      if(rounds>=maxRounds)throw new Error('损伤网格细化未能收敛，请检查材料、模型单位与断裂能。');
      const marked=new Set(report.incompatibleElements),split=new Set();
      const edgeKey=(a,b)=>JSON.stringify([a,b].sort());
      for(const e of mesh.elements)if(marked.has(String(e.id))){
        const ids=(e.analysisNodeIds || e.nodeIds).map(String);
        for(let j=0;j<3;j++)split.add(edgeKey(ids[j],ids[(j+1)%3]));
      }
      let predicted=mesh.elements.length;
      for(const e of mesh.elements){
        const ids=(e.analysisNodeIds || e.nodeIds).map(String);
        for(let j=0;j<3;j++)if(split.has(edgeKey(ids[j],ids[(j+1)%3])))predicted++;
      }
      if(mesh.analysisNodes.length+split.size>maxNodes || predicted>maxElements)
        throw new Error(`损伤网格细化预计超过资源上限（${maxNodes} 节点 / ${maxElements} 单元）。请核对单轴抗拉强度、模型单位与断裂能，或缩小模型范围。`);
      const next=refine(mesh.analysisNodes,mesh.elements,marked,{optimize:false});
      if(!next || next.elements.length===mesh.elements.length)throw new Error('损伤网格已达到最小单元面积，无法继续细化；请检查材料、模型单位与断裂能。');
      mesh=next;rounds++;
      options.onProgress?.({rounds,nodes:mesh.analysisNodes.length,elements:mesh.elements.length});
    }
  }
  return {prepare};
});
