// Generate only the geometry and material needed by scene/UI regressions.
// This fixture is not loaded by the application or distributed as a sample model.
function cavityScene() {
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const circle = Array.from({length: 4}, (_, i) => {
    const angle = i * Math.PI / 2;
    return [.1 * Math.cos(angle), .1 * Math.sin(angle)];
  });
  const geometryNodes = [...corners, ...circle].map(([x, y], i) => ({id: `G${i + 1}`, x, y}));
  const curves = corners.map((_, i) => ({
    id: `C${i + 1}`, type: 'line', geometryNodeIds: [`G${i + 1}`, `G${(i + 1) % 4 + 1}`], controls: [],
  }));
  for (let i = 0; i < 4; i++) {
    const angle = (i + .5) * Math.PI / 2;
    curves.push({id: `C${i + 5}`, type: 'arc', geometryNodeIds: [`G${i + 5}`, `G${(i + 1) % 4 + 5}`],
      controls: [{x: .1 * Math.cos(angle), y: .1 * Math.sin(angle)}]});
  }
  const material = {id: 'test-rock', name: 'Regression rock', elasticModulus: 20,
    poissonRatio: .2, density: 2500, tensileStrength: 2, compressiveStrength: 100, color: '#8b9d83'};
  return {name: 'Cavity regression', geometryNodes, curves, regions: [
    {id: 'R1', boundaryCurveIds: ['C1', 'C2', 'C3', 'C4'], regionKind: 'structure', material},
    {id: 'R2', boundaryCurveIds: ['C5', 'C6', 'C7', 'C8'], regionKind: 'air'},
  ]};
}
module.exports = {cavityScene};
