// Dynamics/Newmark adapted from MFEM 4.10 ex10, ex23 and linalg/ode.cpp.
// Copyright (c) 2010-2026 Lawrence Livermore National Security, LLC.
// BSD-3-Clause: ../mfem-4.10/LICENSE. TRI3 damage, preload, quiet boundaries
// and streamed history are application additions; see ../docs/BLAST_DYNAMICS.md.
#include "BlastDynamics.h"
#include "GasDynamics.h"
#include <Eigen/Dense>
#include <Eigen/Sparse>
#include <Eigen/SparseCholesky>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace fem {
namespace {
using V6=Eigen::Matrix<double,6,1>;
using B36=Eigen::Matrix<double,3,6>;
struct Cell {
  std::array<std::size_t,3> nodes;
  B36 B;
  Eigen::Matrix3d D;
  double area,E,rho,nu,eps0,softening,history=0,damage=0;
  Eigen::Vector3d strain=Eigen::Vector3d::Zero(),stress=Eigen::Vector3d::Zero(),initialStress=Eigen::Vector3d::Zero();
};
struct Edge {std::size_t a=0,b=0,third=0,cell=0;int count=0;};
struct Groups {
  std::vector<std::size_t> p;
  explicit Groups(std::size_t n):p(n){std::iota(p.begin(),p.end(),0);}
  std::size_t Find(std::size_t i){while(p[i]!=i){p[i]=p[p[i]];i=p[i];}return i;}
  void Join(std::size_t a,std::size_t b){a=Find(a);b=Find(b);if(a!=b)p[b]=a;}
};
std::string TextArg(int argc,char* argv[],const std::string& key,const std::string& fallback="") {
  for(int i=1;i<argc;++i)if(argv[i]==key){if(++i>=argc)throw std::runtime_error("Missing blast setting: "+key);return argv[i];}
  return fallback;
}
double Arg(int argc,char* argv[],const std::string& key,double fallback) {
  const auto text=TextArg(argc,argv,key);if(text.empty())return fallback;
  std::size_t used=0;const double x=std::stod(text,&used);
  if(used!=text.size() || !std::isfinite(x))throw std::runtime_error("Invalid blast setting: "+key);
  return x;
}
void Require(bool ok,const char* msg){if(!ok)throw std::runtime_error(msg);}
double Equivalent(const Eigen::Vector3d& s){return std::sqrt(std::max(0.,s[0]*s[0]-s[0]*s[1]+s[1]*s[1]+3*s[2]*s[2]));}
template<typename T>void Raw(std::ostream& out,const T& x){out.write(reinterpret_cast<const char*>(&x),sizeof(x));}
}

int RunBlastDynamics(const CalculationModel& model,int argc,char* argv[],std::ostream& out) {
  const double cx=Arg(argc,argv,"--blast-x",0),cy=Arg(argc,argv,"--blast-y",0),radius=Arg(argc,argv,"--blast-radius",.1);
  const double peak=Arg(argc,argv,"--blast-pressure",1e7),pulse=Arg(argc,argv,"--blast-pulse",1e-4),duration=Arg(argc,argv,"--blast-duration",1e-3);
  const double requestedDt=Arg(argc,argv,"--blast-dt",0),damping=Arg(argc,argv,"--blast-damping",0),gf=Arg(argc,argv,"--blast-gf",100);
  const double frameSetting=Arg(argc,argv,"--blast-frames",61),fracture=Arg(argc,argv,"--blast-fracture",1);
  const double boundarySetting=Arg(argc,argv,"--blast-boundary",0),loadMode=Arg(argc,argv,"--blast-loadMode",0);
  const double confineX=Arg(argc,argv,"--blast-confineX",0),confineY=Arg(argc,argv,"--blast-confineY",0);
  const double planeMode=Arg(argc,argv,"--blast-planeMode",0);
  const double sourceMode=Arg(argc,argv,"--blast-sourceMode",0),productEOS=Arg(argc,argv,"--blast-productEOS",0);
  Require((sourceMode==0 || sourceMode==1) && (productEOS==0 || productEOS==1 || productEOS==2),"Invalid gas source or product EOS mode.");
  const bool gasMode=sourceMode==1;
  Require(radius>0 && peak>=0 && pulse>0 && duration>0 && (gasMode || duration>=pulse),"Blast radius/times must be positive, pressure nonnegative, pulse <= duration.");
  GasParameters gasParameters;gasParameters.radius=radius;
  gasParameters.chargeRadius=Arg(argc,argv,"--blast-chargeRadius",radius);
  gasParameters.productDensity=Arg(argc,argv,"--blast-productDensity",1000);
  gasParameters.productEnergy=Arg(argc,argv,"--blast-productEnergy",1e6);
  gasParameters.A=productEOS==1 ? Arg(argc,argv,"--blast-jwlA",0) : 0;
  gasParameters.B=productEOS==1 ? Arg(argc,argv,"--blast-jwlB",0) : 0;
  gasParameters.R1=productEOS==1 ? Arg(argc,argv,"--blast-jwlR1",4.5) : 4.5;
  gasParameters.R2=productEOS==1 ? Arg(argc,argv,"--blast-jwlR2",1.1) : 1.1;
  gasParameters.omega=productEOS==1 ? Arg(argc,argv,"--blast-jwlOmega",.3) : Arg(argc,argv,"--blast-productGamma",1.3)-1;
  if(gasMode && productEOS==2){
    const double speed=Arg(argc,argv,"--blast-detonationVelocity",2000);
    Require(speed>0 && gasParameters.productEnergy>0,"Equivalent CJ model requires positive detonation velocity and energy.");
    // Strong-CJ calorically perfect products closure, SDToolbox manual A.78.
    gasParameters.omega=std::sqrt(1+speed*speed/(2*gasParameters.productEnergy))-1;
  }
  gasParameters.airDensity=Arg(argc,argv,"--blast-airDensity",1.2);gasParameters.airPressure=Arg(argc,argv,"--blast-airPressure",101325);
  gasParameters.airGamma=Arg(argc,argv,"--blast-airGamma",1.4);
  const double gasCellSetting=Arg(argc,argv,"--blast-gasCells",192);
  Require(gasCellSetting>=16 && gasCellSetting<=2048 && std::floor(gasCellSetting)==gasCellSetting,"Gas cells must be an integer from 16 to 2048.");
  gasParameters.cells=static_cast<int>(gasCellSetting);
  std::unique_ptr<GasDynamics> gas;
  if(gasMode){
    Require(productEOS!=1 || gasParameters.A>0 || gasParameters.B>0,"JWL requires user-supplied expansion coefficients; use ideal products for verification.");
    gas=std::make_unique<GasDynamics>(gasParameters);
  }
  Require(requestedDt>=0 && damping>=0 && gf>0 && frameSetting>=2 && frameSetting<=201 && std::floor(frameSetting)==frameSetting &&
    (fracture==0 || fracture==1) && boundarySetting>=0 && boundarySetting<=3 && std::floor(boundarySetting)==boundarySetting &&
    (loadMode==0 || loadMode==1) && (planeMode==0 || planeMode==1) && confineX>=0 && confineY>=0,"Invalid blast integration/boundary/load settings.");
  Require(!model.elements.empty() && model.nodes.size()>=3,"Blast requires a triangular mesh.");
  const std::size_t nn=model.nodes.size(),nd=nn*2;
  Require(nd<std::numeric_limits<int>::max() && (4.*nn+7.*model.elements.size()+(gasMode ? 12 : 8))*8<=256.*1024*1024,"A single blast frame exceeds 256 MiB; partition the model.");
  int frames=static_cast<int>(frameSetting);
  std::unordered_map<int,std::size_t> nodeIndex;
  for(std::size_t i=0;i<nn;++i)Require(nodeIndex.emplace(model.nodes[i].nodeNo,i).second,"Duplicate blast node number.");
  Eigen::VectorXd mass=Eigen::VectorXd::Zero(nd),bound=mass,u=mass,v=mass,a=mass,pressureForce=mass,external=mass;
  std::vector<bool> fixed(nd);
  for(std::size_t i=0;i<nn;++i){const auto& n=model.nodes[i];fixed[2*i]=n.fixUx;fixed[2*i+1]=n.fixUy;external[2*i]=n.forceX;external[2*i+1]=n.forceY;}
  // Node force is the canonical assembled load, as in the static solver.
  // elementNodeLoads are redundant export records and must NOT be added twice.
  std::map<std::pair<std::size_t,std::size_t>,Edge> edges;
  std::vector<Cell> cells;cells.reserve(model.elements.size());
  Groups solidGroups(nn),boundaryGroups(nn);
  for(const auto& e:model.elements){
    Cell c;c.nodes={nodeIndex.at(e.node1),nodeIndex.at(e.node2),nodeIndex.at(e.node3)};
    const auto& p=model.nodes[c.nodes[0]];const auto& q=model.nodes[c.nodes[1]];const auto& r=model.nodes[c.nodes[2]];
    const double det=(q.x-p.x)*(r.y-p.y)-(r.x-p.x)*(q.y-p.y);
    c.area=.5*std::abs(det);c.E=e.elasticModulus;c.rho=e.density;c.nu=e.poissonRatio;
    Require(c.area>1e-18 && std::isfinite(c.area) && c.rho>0 && std::isfinite(c.rho) && c.E>0 && std::isfinite(c.E) && c.nu>-1 && c.nu<.5,
      "Blast elements require positive area, density, E and -1 < nu < 0.5.");
    const double s1=((q.x-p.x)*(cy-p.y)-(q.y-p.y)*(cx-p.x))/det,s2=((cx-p.x)*(r.y-p.y)-(cy-p.y)*(r.x-p.x))/det;
    Require(!(s1>=-1e-10 && s2>=-1e-10 && s1+s2<=1+1e-10),"Blast center must lie in an explicitly meshed circular cavity.");
    const double gx[3]={(q.y-r.y)/det,(r.y-p.y)/det,(p.y-q.y)/det},gy[3]={(r.x-q.x)/det,(p.x-r.x)/det,(q.x-p.x)/det};
    c.B.setZero();for(int j=0;j<3;++j){c.B(0,2*j)=gx[j];c.B(1,2*j+1)=gy[j];c.B(2,2*j)=gy[j];c.B(2,2*j+1)=gx[j];}
    c.D<<1,c.nu,0,c.nu,1,0,0,0,(1-c.nu)/2;c.D*=c.E/(1-c.nu*c.nu);
    if(planeMode==1){c.D<<1-c.nu,c.nu,0,c.nu,1-c.nu,0,0,0,(1-2*c.nu)/2;c.D*=c.E/((1+c.nu)*(1-2*c.nu));}
    c.eps0=fracture ? e.tensileStrength/c.E : 0;
    c.softening=fracture ? gf/(std::sqrt(2*c.area)*e.tensileStrength)-.5*c.eps0 : 1;
    Require(!fracture || (e.tensileStrength>0 && std::isfinite(e.tensileStrength) && c.softening>0 && std::isfinite(c.softening)),
      "Fracture needs positive tensile strength and Gf/h > ft^2/(2E); refine mesh or check material/Gf.");
    const Eigen::Matrix<double,6,6> k=c.area*c.B.transpose()*c.D*c.B;
    for(int j=0;j<6;++j){const auto d=2*c.nodes[j/2]+j%2;mass[d]+=c.rho*c.area/3;bound[d]+=k.row(j).cwiseAbs().sum();}
    for(int j=0;j<3;++j){
      const auto aa=c.nodes[j],bb=c.nodes[(j+1)%3];solidGroups.Join(aa,bb);
      auto& edge=edges[std::minmax(aa,bb)];edge.a=aa;edge.b=bb;edge.third=c.nodes[(j+2)%3];edge.cell=cells.size();++edge.count;
      Require(edge.count<=2,"Blast mesh contains a nonmanifold edge.");
    }
    cells.push_back(c);
  }
  for(const auto& item:edges)if(item.second.count==1)boundaryGroups.Join(item.second.a,item.second.b);
  std::map<std::size_t,double> boundaryAreas;
  for(const auto& item:edges)if(item.second.count==1){
    const auto& e=item.second;const auto& p=model.nodes[e.a];const auto& q=model.nodes[e.b];const auto& r=model.nodes[e.third];
    const double cross=(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    boundaryAreas[boundaryGroups.Find(e.a)]+=(cross>0 ? 1 : -1)*(p.x*q.y-p.y*q.x);
  }
  std::map<std::pair<std::size_t,std::size_t>,int> overrides;
  const auto boundaryFile=TextArg(argc,argv,"--blast-boundary-file");
  if(!boundaryFile.empty()){
    std::ifstream input(std::filesystem::u8path(boundaryFile));Require(input.good(),"Cannot read blast boundary overrides.");
    int na,nb,mode;
    while(input>>na>>nb>>mode){
      Require(mode>=0 && mode<=3 && nodeIndex.count(na) && nodeIndex.count(nb),"Invalid blast boundary override.");
      auto key=std::minmax(nodeIndex.at(na),nodeIndex.at(nb));
      Require(edges.count(key) && edges.at(key).count==1,"Boundary override must reference a true exterior mesh edge.");
      Require(overrides.emplace(key,mode).second,"Duplicate blast boundary override.");
    }
    Require(input.eof(),"Malformed blast boundary override file.");
  }
  std::vector<Eigen::Matrix2d> dashpot(nn,Eigen::Matrix2d::Zero());
  std::vector<int> nodeMode(nn,0);
  std::map<std::size_t,int> loadedDegree;
  int loadedEdges=0,absorbingEdges=0,fixedBoundaryEdges=0;
  for(const auto& item:edges){
    const auto& e=item.second;if(e.count!=1)continue;
    const auto& p=model.nodes[e.a];const auto& q=model.nodes[e.b];const auto& r=model.nodes[e.third];
    const double dx=q.x-p.x,dy=q.y-p.y,length=std::hypot(dx,dy);
    Eigen::Vector2d inward(-dy/length,dx/length);
    if(inward.dot(Eigen::Vector2d(r.x-(p.x+q.x)/2,r.y-(p.y+q.y)/2))<0)inward=-inward;
    const double tol=std::max(radius*.03,1e-10);
    const bool cavity=std::abs(std::hypot(p.x-cx,p.y-cy)-radius)<=tol && std::abs(std::hypot(q.x-cx,q.y-cy)-radius)<=tol;
    if(cavity){
      Require(inward.dot(Eigen::Vector2d((p.x+q.x)/2-cx,(p.y+q.y)/2-cy))>0,"Selected pressure boundary is not a cavity wall.");
      for(auto i:{e.a,e.b}){pressureForce.segment<2>(2*i)+=.5*length*inward;++loadedDegree[i];}++loadedEdges;continue;
    }
    const bool outer=boundaryAreas[boundaryGroups.Find(e.a)]>0;
    const auto overrideMode=overrides.find(item.first);
    const int mode=overrideMode!=overrides.end() ? overrideMode->second : outer ? static_cast<int>(boundarySetting) : 0;
    if(outer)for(auto i:{e.a,e.b}){external[2*i]+=.5*length*confineX*inward[0];external[2*i+1]+=.5*length*confineY*inward[1];}
    if(mode==3)++fixedBoundaryEdges;
    for(auto i:{e.a,e.b})nodeMode[i]=std::max(nodeMode[i],mode);
    if(mode==2){
      const auto& c=cells[e.cell];const double cp=std::sqrt(c.D(0,0)/c.rho),cs=std::sqrt(c.E/(2*c.rho*(1+c.nu)));
      const Eigen::Matrix2d C=.5*length*c.rho*(cs*Eigen::Matrix2d::Identity()+(cp-cs)*inward*inward.transpose());
      for(auto i:{e.a,e.b})dashpot[i]+=C;++absorbingEdges;
    }
  }
  Require(loadedEdges>=6,"No closed circular cavity with at least 6 boundary edges matches blast center/radius.");
  for(const auto& item:loadedDegree)Require(item.second==2,"Blast cavity boundary must be a complete closed loop.");
  for(std::size_t i=0;i<nn;++i)if(nodeMode[i])fixed[2*i]=fixed[2*i+1]=nodeMode[i]==3;
  double lambdaBound=0;
  for(std::size_t i=0;i<nd;++i){Require(mass[i]>0 && std::isfinite(mass[i]) && std::isfinite(bound[i]),"Unconnected node or invalid blast mass/stiffness.");if(!fixed[i])lambdaBound=std::max(lambdaBound,bound[i]/mass[i]);}
  Require(lambdaBound>0 && std::isfinite(lambdaBound),"Blast model has no movable degrees of freedom.");
  const double stableDt=1.4/std::sqrt(lambdaBound);
  double sourceDt=pulse/20;
  if(gasMode){
    const auto products=GasDynamics::ProductsEOS(gasParameters,gasParameters.productDensity,gasParameters.productEnergy);
    const double sound=std::max(std::sqrt(products.soundSpeedSquared),std::sqrt(gasParameters.airGamma*gasParameters.airPressure/gasParameters.airDensity));
    const double gap=radius-gasParameters.chargeRadius;
    sourceDt=std::min(gasParameters.chargeRadius,gap>radius*1e-8 ? gap : radius)/(20*sound);
    external+=gasParameters.airPressure*pressureForce;
  }
  const double dtLimit=std::min(stableDt,sourceDt);
  Require(requestedDt==0 || requestedDt<=dtLimit*(1+1e-12),"Requested blast dt exceeds stability or pressure-resolution limit; use dt=0.");
  const double stepsNeeded=std::ceil(duration/(requestedDt>0 ? requestedDt : dtLimit));
  Require(std::isfinite(stepsNeeded) && stepsNeeded<=20000000,"Blast needs over 20 million steps; check tiny elements or simulation duration.");
  const int steps=static_cast<int>(stepsNeeded);frames=std::min(frames,steps+1);const double dt=duration/steps;
  const int workers=cells.size()>=4096 ? static_cast<int>(std::min(8u,std::max(1u,std::thread::hardware_concurrency()))) : 1;
  std::vector<V6> localForce(cells.size());
  std::vector<std::vector<std::pair<std::size_t,int>>> incident(nn);
  for(std::size_t k=0;k<cells.size();++k)for(int j=0;j<3;++j)incident[cells[k].nodes[j]].push_back({k,j});
  auto internal=[&,workers](bool evolve){
    #pragma omp parallel for num_threads(workers) if(workers>1)
    for(int k=0;k<static_cast<int>(cells.size());++k){
      auto& c=cells[k];V6 ue;for(int j=0;j<6;++j)ue[j]=u[2*c.nodes[j/2]+j%2];c.strain=c.B*ue;
      const Eigen::Vector3d trial=c.D*c.strain;
      const double mean=.5*(trial[0]+trial[1]),rad=std::hypot(.5*(trial[0]-trial[1]),trial[2]),s1=mean+rad,s2=mean-rad;
      if(fracture && evolve){c.history=std::max(c.history,std::max(0.,s1)/c.E);if(c.history>c.eps0)c.damage=std::max(c.damage,1-c.eps0/c.history*std::exp(-(c.history-c.eps0)/c.softening));}
      const double g=std::max(1e-6,1-c.damage),t1=s1>0 ? g*s1 : s1,t2=s2>0 ? g*s2 : s2,factor=rad>0 ? (t1-t2)/(2*rad) : 0;
      c.stress<<.5*(t1+t2)+factor*.5*(trial[0]-trial[1]),.5*(t1+t2)-factor*.5*(trial[0]-trial[1]),factor*trial[2];
      localForce[k]=c.area*c.B.transpose()*c.stress;
    }
    Eigen::VectorXd f=Eigen::VectorXd::Zero(nd);
    #pragma omp parallel for num_threads(workers) if(workers>1)
    for(int i=0;i<static_cast<int>(nn);++i)for(const auto& source:incident[i])f.segment<2>(2*i)+=localForce[source.first].segment<2>(2*source.second);
    return f;
  };
  double preloadResidual=0;
  if(loadMode==0 && external.squaredNorm()>0){
    // Static-only gauge constraints remove missing rigid modes. Their reactions
    // must vanish: unbalanced loads are never held by hidden physical supports.
    std::vector<bool> staticFixed=fixed;
    std::map<std::size_t,std::vector<std::size_t>> components;
    for(std::size_t i=0;i<nn;++i)components[solidGroups.Find(i)].push_back(i);
    for(const auto& component:components){
      const auto& ids=component.second;const auto& origin=model.nodes[ids.front()];double scale=1e-12;
      for(auto i:ids)scale=std::max(scale,std::hypot(model.nodes[i].x-origin.x,model.nodes[i].y-origin.y));
      std::vector<Eigen::Vector3d> basis;
      auto independent=[&](std::size_t i,int axis){
        Eigen::Vector3d row=axis==0 ? Eigen::Vector3d(1,0,-(model.nodes[i].y-origin.y)/scale) : Eigen::Vector3d(0,1,(model.nodes[i].x-origin.x)/scale);
        for(const auto& b:basis)row-=b.dot(row)*b;
        if(row.norm()<1e-9)return false;basis.push_back(row.normalized());return true;
      };
      for(auto i:ids)for(int axis=0;axis<2;++axis)if(fixed[2*i+axis])independent(i,axis);
      for(auto i:ids)for(int axis=0;axis<2 && basis.size()<3;++axis)if(!staticFixed[2*i+axis] && independent(i,axis))staticFixed[2*i+axis]=true;
    }
    std::vector<int> freeIndex(nd,-1);int nf=0;for(std::size_t i=0;i<nd;++i)if(!staticFixed[i])freeIndex[i]=nf++;
    if(nf){
      std::vector<Eigen::Triplet<double>> triplets;triplets.reserve(cells.size()*36);
      for(const auto& c:cells){const Eigen::Matrix<double,6,6> k=c.area*c.B.transpose()*c.D*c.B;
        for(int i=0;i<6;++i){const int row=freeIndex[2*c.nodes[i/2]+i%2];if(row<0)continue;
          for(int j=0;j<6;++j){const int col=freeIndex[2*c.nodes[j/2]+j%2];if(col>=0)triplets.emplace_back(row,col,k(i,j));}}
      }
      Eigen::SparseMatrix<double> K(nf,nf);K.setFromTriplets(triplets.begin(),triplets.end());triplets.clear();triplets.shrink_to_fit();
      Eigen::VectorXd rhs(nf);for(std::size_t i=0;i<nd;++i)if(freeIndex[i]>=0)rhs[freeIndex[i]]=external[i];
      Eigen::SimplicialLDLT<Eigen::SparseMatrix<double>> solver;solver.compute(K);
      Require(solver.info()==Eigen::Success && solver.vectorD().minCoeff()>0,"Initial stress equilibrium stiffness is singular; check constraints and disconnected mesh.");
      const Eigen::VectorXd solution=solver.solve(rhs);Require(solver.info()==Eigen::Success && solution.allFinite(),"Initial stress equilibrium solve failed.");
      for(std::size_t i=0;i<nd;++i)if(freeIndex[i]>=0)u[i]=solution[freeIndex[i]];
    }
    const Eigen::VectorXd initialInternal=internal(false);
    Eigen::VectorXd residual=initialInternal-external;for(std::size_t i=0;i<nd;++i)if(fixed[i])residual[i]=0;
    preloadResidual=residual.norm()/std::max(external.norm(),1e-30);
    Require(preloadResidual<1e-7,"External loads cannot equilibrate without rigid-body reactions. Add physical supports, balance forces/moments, or select sudden loading.");
    for(const auto& c:cells)if(fracture){
      const double tensile=.5*(c.stress[0]+c.stress[1])+std::hypot(.5*(c.stress[0]-c.stress[1]),c.stress[2]);
      Require(tensile<=c.E*c.eps0*(1+1e-7),"Initial elastic equilibrium already exceeds tensile strength. Pre-damaged static equilibrium is not supported; check confinement/material or disable damage.");
    }
  }else internal(false);
  double preloadEnergy=0;for(auto& c:cells){c.initialStress=c.stress;preloadEnergy+=.5*c.area*c.strain.dot(c.stress);}
  std::vector<Eigen::Matrix2d> inverseMass(nn);
  for(std::size_t i=0;i<nn;++i){
    dashpot[i]+=damping*mass[2*i]*Eigen::Matrix2d::Identity();
    Eigen::Matrix2d lhs=mass[2*i]*Eigen::Matrix2d::Identity()+.5*dt*dashpot[i];
    for(int axis=0;axis<2;++axis)if(fixed[2*i+axis]){lhs.row(axis).setZero();lhs.col(axis).setZero();lhs(axis,axis)=1;}
    inverseMass[i]=lhs.inverse();
  }
  if(loadMode==1)for(std::size_t i=0;i<nd;++i)if(!fixed[i])a[i]=external[i]/mass[i];
  double currentGasPressure=gasMode ? gas->Snapshot().wallPressure : 0.;
  const Eigen::VectorXd referenceU=u;
  if(gasMode){
    const Eigen::VectorXd initialForce=external+(currentGasPressure-gasParameters.airPressure)*pressureForce-internal(false);
    for(std::size_t i=0;i<nd;++i)if(!fixed[i])a[i]=initialForce[i]/mass[i];
  }
  auto pressure=[&](double t){return gasMode ? currentGasPressure : t>=0 && t<pulse ? peak*std::sin(3.14159265358979323846*t/pulse) : 0.;};
  std::ostringstream metadata;metadata<<std::setprecision(16)<<"{\"nodeCount\":"<<nn<<",\"elementCount\":"<<cells.size()<<",\"frameCount\":"<<frames
    <<",\"dt\":"<<dt<<",\"stableDt\":"<<stableDt<<",\"steps\":"<<steps<<",\"loadedEdges\":"<<loadedEdges<<",\"absorbingEdges\":"<<absorbingEdges
    <<",\"fixedBoundaryEdges\":"<<fixedBoundaryEdges<<",\"preloadResidual\":"<<preloadResidual<<",\"preloadEnergy\":"<<preloadEnergy<<",\"workers\":"<<workers
    <<",\"effectiveProductGamma\":"<<(gasParameters.omega+1)<<",\"productEOS\":"<<productEOS<<",\"sourceMode\":"<<sourceMode<<",\"frameScalarCount\":"<<(gasMode ? 12 : 8)<<",\"initialGasEnergy\":"<<(gasMode ? gas->InitialEnergy() : 0)<<"}";
  const std::string json=metadata.str();out.write("FEMBLT02",8);Raw(out,static_cast<std::uint32_t>(json.size()));out.write(json.data(),json.size());
  int saved=0;double externalWork=0,dissipated=0;
  std::vector<std::array<double,7>> cellOutput(cells.size());
  for(int step=0;step<=steps;++step){
    const double time=step*dt;
    if(step==0 || step==static_cast<int>(std::llround(static_cast<double>(saved)*steps/(frames-1))) || step==steps){
      double elastic=0,maxStress=0,maxDynamic=0;
      for(std::size_t i=0;i<cells.size();++i){const auto& c=cells[i];elastic+=.5*c.area*c.strain.dot(c.stress);
        maxStress=std::max(maxStress,Equivalent(c.stress));maxDynamic=std::max(maxDynamic,Equivalent(c.stress-c.initialStress));
        cellOutput[i]={c.strain[0],c.strain[1],c.strain[2],c.stress[0],c.stress[1],c.stress[2],c.damage};}
      const std::array<double,8> info={time,pressure(time),.5*(mass.array()*v.array().square()).sum(),elastic,externalWork,dissipated,maxStress,maxDynamic};
      out.write(reinterpret_cast<const char*>(info.data()),sizeof(info));
      if(gasMode){const auto state=gas->Snapshot();const std::array<double,4> extra={state.internalEnergy,state.kineticEnergy,state.wallWork,state.radius};out.write(reinterpret_cast<const char*>(extra.data()),sizeof(extra));}
      out.write(reinterpret_cast<const char*>(u.data()),nd*sizeof(double));out.write(reinterpret_cast<const char*>(v.data()),nd*sizeof(double));
      out.write(reinterpret_cast<const char*>(cellOutput.data()),cellOutput.size()*sizeof(cellOutput[0]));
      Require(out.good(),"Failed writing streamed blast frame.");++saved;
    }
    if(step==steps)break;
    const Eigen::VectorXd oldU=u,oldV=v;
    u+=dt*v+(.5*dt*dt)*a;v+=(.5*dt)*a;
    double gasAverage=0;
    if(gasMode){
      // Small-strain area change is integral(u.n ds). Mapping it to pi R^2
      // makes the radial fluid's wall-volume work match the solid interface work.
      const double wallArea=3.14159265358979323846*radius*radius+pressureForce.dot(u-referenceU);
      Require(wallArea>0,"Mean cavity area collapsed in gas coupling.");
      gasAverage=gas->Advance(time+dt,std::sqrt(wallArea/3.14159265358979323846));
      currentGasPressure=gas->WallPressure();
    }
    const double forcingPressure=gasMode ? gasAverage-gasParameters.airPressure : pressure(time+dt);
    const Eigen::VectorXd force=external+forcingPressure*pressureForce-internal(true);
    #pragma omp parallel for num_threads(workers) if(workers>1)
    for(int i=0;i<static_cast<int>(nn);++i){
      Eigen::Vector2d rhs=force.segment<2>(2*i)-dashpot[i]*v.segment<2>(2*i);
      for(int axis=0;axis<2;++axis)if(fixed[2*i+axis])rhs[axis]=0;
      a.segment<2>(2*i)=inverseMass[i]*rhs;v.segment<2>(2*i)+=.5*dt*a.segment<2>(2*i);
    }
    Require(u.allFinite() && v.allFinite() && a.allFinite(),"Blast solution diverged; check mesh/material/time step.");
    const double workPressure=gasMode ? gasAverage-gasParameters.airPressure : .5*(pressure(time)+pressure(time+dt));
    externalWork+=(external+workPressure*pressureForce).dot(u-oldU);
    for(std::size_t i=0;i<nn;++i)dissipated+=.5*dt*(oldV.segment<2>(2*i).dot(dashpot[i]*oldV.segment<2>(2*i))+v.segment<2>(2*i).dot(dashpot[i]*v.segment<2>(2*i)));
  }
  out.flush();return 0;
}
}
