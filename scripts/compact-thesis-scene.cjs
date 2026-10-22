// Drop reproducible classification snapshots while retaining constrained region
// attributes, boundary/load provenance and full mesh topology for normal import.
function compactScene(data){
  data.analysisNodes=data.analysisNodes.map(n=>({id:n.id,x:n.x,y:n.y,mechanicalState:n.mechanicalState,
    ...(n.placement && n.placement.sourceType!=="regionInterior" ? {placement:n.placement} : {})}));
  const nodes=new Map(data.analysisNodes.map(n=>[n.id,n])),areas=new Map();
  data.mesh.elements=data.mesh.elements.map(e=>{
    const [a,b,c]=e.analysisNodeIds.map(id=>nodes.get(id));
    const area=Math.abs((b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y))/2;
    areas.set(e.regionId,(areas.get(e.regionId)||0)+area);
    return {id:e.id,type:"TRI3",analysisNodeIds:e.analysisNodeIds,regionId:e.regionId,generation:e.generation,area,
      edges:(e.edges || []).filter(edge=>edge.boundary),boundaryCurveIds:e.boundaryCurveIds};
  });
  for(const set of data.mesh.metadata.regionElementSets || [])set.area=areas.get(set.regionId) || 0;
  return data;
}
module.exports={compactScene};
