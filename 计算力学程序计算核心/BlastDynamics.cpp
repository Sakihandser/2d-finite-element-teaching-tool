// Dynamics/Newmark adapted from MFEM 4.10 ex10, ex23 and linalg/ode.cpp.
// Copyright (c) 2010-2026 Lawrence Livermore National Security, LLC.
// BSD-3-Clause: ../mfem-4.10/LICENSE. TRI3 damage, preload, quiet boundaries
// and streamed history are application additions; see ../docs/BLAST_DYNAMICS.md.
#include "BlastDynamics.h"
#include "GasDynamics.h"
#include "RockConstitutive.h"
#include <Eigen/Dense>
#include <Eigen/Sparse>
#include <Eigen/SparseCholesky>
#include <algorithm>
#include <array>
#include <cmath>
#include <chrono>
#include <iostream>
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
#include <tuple>
#include <unordered_map>
#include <vector>

namespace fem {
namespace {
using V6=Eigen::Matrix<double,6,1>;
using B36=Eigen::Matrix<double,3,6>;
struct Cell {
  std::array<std::size_t,3> nodes;
  B36 B;
  Eigen::Matrix2d previousF=Eigen::Matrix2d::Identity();
  double initialJacobian=1,currentJacobian=1,localTimeLimit=1,initialZz=0;
  Eigen::Matrix3d D;
  double area,E,rho,nu,eps0,softening,history=0,damage=0;
  Eigen::Vector3d strain=Eigen::Vector3d::Zero(),stress=Eigen::Vector3d::Zero(),initialStress=Eigen::Vector3d::Zero();
  rock::Parameters rockParameters;
  rock::State rockState;
  std::vector<std::size_t> neighbours;
  bool cavityCell=false;
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
double Equivalent(const Eigen::Vector3d& s,double zz=0){return std::sqrt(std::max(0.,s[0]*s[0]+s[1]*s[1]+zz*zz-s[0]*s[1]-s[1]*zz-zz*s[0]+3*s[2]*s[2]));}
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
  const double rockModel=Arg(argc,argv,"--blast-rockModel",0),gasFracture=Arg(argc,argv,"--blast-gasFracture",0),crackDamage=Arg(argc,argv,"--blast-crackDamage",.95);
  const double kinematics=Arg(argc,argv,"--blast-kinematics",0);
  Require((kinematics==0 || kinematics==1) && (kinematics==0 || planeMode==1),"Finite deformation currently requires plane strain.");
  Require(rockModel>=0 && rockModel<=3 && std::floor(rockModel)==rockModel && (gasFracture==0 || gasFracture==1) && crackDamage>0 && crackDamage<=1,"Invalid rock or fracture-storage selection.");
  std::map<int,rock::Parameters> rockCards;
  const auto rockFile=TextArg(argc,argv,"--blast-rock-file");
  if(!rockFile.empty()){
    std::ifstream file(std::filesystem::u8path(rockFile));Require(file.good(),"Cannot read rock material cards.");
    std::string line;while(std::getline(file,line)){if(line.empty())continue;std::istringstream row(line);int id;rock::Parameters p;
      Require(bool(row>>id>>p.law>>p.A>>p.N>>p.B>>p.M>>p.C>>p.rate0>>p.HEL>>p.pHEL>>p.T>>p.D1>>p.D2>>p.maxStrength>>p.K1>>p.K2>>p.K3>>p.beta>>p.referenceLength>>p.normalizationStress>>p.friction>>p.dilation),"Malformed rock material card.");
      std::string extra;Require(!(row>>extra) && id>0 && p.law>=0 && p.law<=3 && !rockCards.count(id),"Invalid/duplicate rock material card.");rockCards[id]=p;
    }
  }
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
  const double ventEnds=Arg(argc,argv,"--blast-ventEnds",0);Require(ventEnds>=0 && ventEnds<=2 && std::floor(ventEnds)==ventEnds,"Invalid axial vent geometry or opening time.");
  gasParameters.ventEnds=static_cast<int>(ventEnds);gasParameters.specimenThickness=Arg(argc,argv,"--blast-specimenThickness",.05);gasParameters.ventOpeningTime=Arg(argc,argv,"--blast-ventOpeningTime",0);
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
  bool advanced=rockModel!=0 || gasFracture!=0 || kinematics!=0 || ventEnds>0 || planeMode==1;
  Groups solidGroups(nn),boundaryGroups(nn);
  for(const auto& e:model.elements){
    Cell c;c.nodes={nodeIndex.at(e.node1),nodeIndex.at(e.node2),nodeIndex.at(e.node3)};
    const auto& p=model.nodes[c.nodes[0]];const auto& q=model.nodes[c.nodes[1]];const auto& r=model.nodes[c.nodes[2]];
    const double det=(q.x-p.x)*(r.y-p.y)-(r.x-p.x)*(q.y-p.y);
    c.area=.5*std::abs(det);c.E=e.elasticModulus;c.rho=e.density;c.nu=e.poissonRatio;
    if(rockCards.count(e.materialNo))c.rockParameters=rockCards.at(e.materialNo);
    else {c.rockParameters.law=static_cast<int>(rockModel);Require(rockModel==0 || rockModel==1,"Selected rock model requires a material card.");}
    auto& rp=c.rockParameters;rp.E=c.E;rp.nu=c.nu;rp.ft=e.tensileStrength;rp.fc=e.compressiveStrength;rp.gf=gf;rp.h=std::sqrt(2*c.area);
    rp.logarithmicVolume=kinematics==1;
    if(rp.law==3){
      Require(rp.A>0 && rp.N>0 && rp.B>=0 && rp.M>0 && rp.C>=0 && rp.rate0>0 && rp.HEL>rp.pHEL && rp.pHEL>0 && rp.T>0 && rp.D1>0 && rp.D2>=0 && rp.maxStrength>=0 && rp.K1>0 && rp.K3>=0 && rp.beta>=0 && rp.beta<=1 && rp.referenceLength>=0 && rp.normalizationStress>=0,"Invalid JH2 parameters.");
      Require((rp.K3>0 || rp.K2>=0) && (rp.K2>=0 || rp.K1-rp.K2*rp.K2/(3*rp.K3)>0),"JH2 compression EOS is not hyperbolic.");
      // JH2's EOS controls initial bulk stiffness; G still comes from E/nu.
      const double G=rp.G(),K=rp.K1;rp.E=c.E=9*K*G/(3*K+G);rp.nu=c.nu=(3*K-2*G)/(2*(3*K+G));
    }
    if(rp.law==2)Require(rp.fc>0 && rp.ft>0 && rp.friction>=0 && rp.friction<60 && rp.dilation>=0 && rp.dilation<=rp.friction,"DP requires compression/tension strengths and valid friction/dilation angles.");
    advanced=advanced || rp.law!=0;
    Require(c.area>1e-18 && std::isfinite(c.area) && c.rho>0 && std::isfinite(c.rho) && c.E>0 && std::isfinite(c.E) && c.nu>-1 && c.nu<.5,
      "Blast elements require positive area, density, E and -1 < nu < 0.5.");
    const double s1=((q.x-p.x)*(cy-p.y)-(q.y-p.y)*(cx-p.x))/det,s2=((cx-p.x)*(r.y-p.y)-(cy-p.y)*(r.x-p.x))/det;
    Require(!(s1>=-1e-10 && s2>=-1e-10 && s1+s2<=1+1e-10),"Blast center must lie in an explicitly meshed circular cavity.");
    const double gx[3]={(q.y-r.y)/det,(r.y-p.y)/det,(p.y-q.y)/det},gy[3]={(r.x-q.x)/det,(p.x-r.x)/det,(q.x-p.x)/det};
    c.B.setZero();for(int j=0;j<3;++j){c.B(0,2*j)=gx[j];c.B(1,2*j+1)=gy[j];c.B(2,2*j)=gy[j];c.B(2,2*j+1)=gx[j];}
    c.D<<1,c.nu,0,c.nu,1,0,0,0,(1-c.nu)/2;c.D*=c.E/(1-c.nu*c.nu);
    if(planeMode==1){c.D<<1-c.nu,c.nu,0,c.nu,1-c.nu,0,0,0,(1-2*c.nu)/2;c.D*=c.E/((1+c.nu)*(1-2*c.nu));}
    const bool tensileLaw=rp.law==0 || rp.law==2;
    c.eps0=fracture && tensileLaw ? e.tensileStrength/c.E : 0;
    c.softening=fracture && tensileLaw ? gf/(std::sqrt(2*c.area)*e.tensileStrength)-.5*c.eps0 : 1;
    Require(!fracture || !tensileLaw || (e.tensileStrength>0 && std::isfinite(e.tensileStrength) && c.softening>0 && std::isfinite(c.softening)),
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
  // Shared edges supply the crack connectivity graph, including material interfaces.
  std::map<std::pair<std::size_t,std::size_t>,std::size_t> edgeOwner;
  for(std::size_t k=0;k<cells.size();++k)for(int j=0;j<3;++j){auto key=std::minmax(cells[k].nodes[j],cells[k].nodes[(j+1)%3]);auto found=edgeOwner.find(key);
    if(found==edgeOwner.end())edgeOwner[key]=k;else {cells[k].neighbours.push_back(found->second);cells[found->second].neighbours.push_back(k);}}
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
  std::vector<std::tuple<std::size_t,std::size_t,double>> cavitySegments;
  for(const auto& item:edges){
    const auto& e=item.second;if(e.count!=1)continue;
    const auto& p=model.nodes[e.a];const auto& q=model.nodes[e.b];const auto& r=model.nodes[e.third];
    const double dx=q.x-p.x,dy=q.y-p.y,length=std::hypot(dx,dy);
    Eigen::Vector2d inward(-dy/length,dx/length);
    if(inward.dot(Eigen::Vector2d(r.x-(p.x+q.x)/2,r.y-(p.y+q.y)/2))<0)inward=-inward;
    const double tol=std::max(radius*.03,1e-10);
    const bool cavity=std::abs(std::hypot(p.x-cx,p.y-cy)-radius)<=tol && std::abs(std::hypot(q.x-cx,q.y-cy)-radius)<=tol;
    if(cavity){
      cells[e.cell].cavityCell=true;
      cavitySegments.emplace_back(e.a,e.b,inward.dot(Eigen::Vector2d(-dy/length,dx/length)));
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
  const int steps=static_cast<int>(stepsNeeded);frames=std::min(frames,steps+1);double dt=duration/steps;const double baseDt=dt;
  const int workers=cells.size()>=4096 ? static_cast<int>(std::min(8u,std::max(1u,std::thread::hardware_concurrency()))) : 1;
  std::vector<V6> localForce(cells.size());
  std::vector<std::vector<std::pair<std::size_t,int>>> incident(nn);
  for(std::size_t k=0;k<cells.size();++k)for(int j=0;j<3;++j)incident[cells[k].nodes[j]].push_back({k,j});
  auto internal=[&,workers](bool evolve){
    std::string rockError;
    #pragma omp parallel for num_threads(workers) if(workers>1)
    for(int k=0;k<static_cast<int>(cells.size());++k){
      auto& c=cells[k];V6 ue;for(int j=0;j<6;++j)ue[j]=u[2*c.nodes[j/2]+j%2];c.strain=c.B*ue;
      if(evolve && (c.rockParameters.law!=0 || kinematics==1)){
        try {
          B36 spatialB=c.B;
          if(kinematics==1){
            Eigen::Matrix2d F=Eigen::Matrix2d::Identity();
            for(int j=0;j<3;++j){F(0,0)+=ue[2*j]*c.B(0,2*j);F(0,1)+=ue[2*j]*c.B(1,2*j+1);F(1,0)+=ue[2*j+1]*c.B(0,2*j);F(1,1)+=ue[2*j+1]*c.B(1,2*j+1);}
            const double J=F.determinant();Require(J>1e-4 && F.allFinite(),"Finite-deformation mesh inverted/collapsed; this case requires remeshing or a particle solver.");
            const Eigen::Matrix2d relative=F*c.previousF.inverse();
            // Closed-form 2D polar decomposition avoids an eigensolver in every
            // element at every explicit step, including the unperturbed bulk.
            const double cosine=relative(0,0)+relative(1,1),sine=relative(1,0)-relative(0,1),norm=std::hypot(cosine,sine);
            Require(norm>0,"Invalid finite-deformation stretch.");Eigen::Matrix2d R;R<<cosine/norm,-sine/norm,sine/norm,cosine/norm;
            const Eigen::Matrix2d stretch=R.transpose()*relative;const double mean=.5*stretch.trace(),radius=std::hypot(.5*(stretch(0,0)-stretch(1,1)),stretch(0,1));
            const double plus=mean+radius,minus=relative.determinant()/plus;Require(minus>0 && plus>0,"Invalid finite-deformation stretch.");
            const double logPlus=std::log(plus),logMinus=std::log(minus),factor=radius>1e-12 ? (logPlus-logMinus)/(2*radius) : 1/mean;
            const Eigen::Matrix2d logU=.5*(logPlus+logMinus)*Eigen::Matrix2d::Identity()+factor*(stretch-mean*Eigen::Matrix2d::Identity());
            rock::Tensor rotation=rock::Tensor::Identity();rotation.block<2,2>(0,0)=R;
            c.rockState.stress=(rotation*c.rockState.stress*rotation.transpose()).eval();c.rockState.effective=(rotation*c.rockState.effective*rotation.transpose()).eval();c.rockState.strain=(rotation*c.rockState.strain*rotation.transpose()).eval();
            const Eigen::Matrix2d delta=R*logU*R.transpose();c.strain<<c.rockState.strain(0,0)+delta(0,0),c.rockState.strain(1,1)+delta(1,1),2*(c.rockState.strain(0,1)+delta(0,1));
            const Eigen::Matrix2d inverse=F.inverse().transpose();spatialB.setZero();
            for(int j=0;j<3;++j){const Eigen::Vector2d gradient=inverse*Eigen::Vector2d(c.B(0,2*j),c.B(1,2*j+1));spatialB(0,2*j)=gradient[0];spatialB(1,2*j+1)=gradient[1];spatialB(2,2*j)=gradient[1];spatialB(2,2*j+1)=gradient[0];}
            c.previousF=F;c.currentJacobian=J;
            double maxEdge=0;for(int j=0;j<3;++j){const auto a=c.nodes[j],b=c.nodes[(j+1)%3];maxEdge=std::max(maxEdge,std::hypot(model.nodes[a].x+u[2*a]-model.nodes[b].x-u[2*b],model.nodes[a].y+u[2*a+1]-model.nodes[b].y-u[2*b+1]));}
            const double mu=std::max(0.,1/J-1),bulk=c.rockParameters.law==3 ? (c.rockParameters.K1+2*c.rockParameters.K2*mu+3*c.rockParameters.K3*mu*mu)*(1+mu) : c.rockParameters.K();
            c.localTimeLimit=.45*(2*c.area*J/maxEdge)/std::sqrt((bulk+4*c.rockParameters.G()/3)/(c.rho/J));
          }
          c.rockState=rock::Advance(c.rockParameters,c.rockState,c.strain,dt,planeMode==1,fracture!=0);
          c.damage=c.rockState.damage;c.stress<<c.rockState.stress(0,0),c.rockState.stress(1,1),c.rockState.stress(0,1);localForce[k]=c.area*c.currentJacobian*spatialB.transpose()*c.stress;
        }catch(const std::exception& ex){
          #pragma omp critical
          {if(rockError.empty())rockError=ex.what();}
        }
        continue;
      }
      const Eigen::Vector3d trial=c.D*c.strain;
      const double mean=.5*(trial[0]+trial[1]),rad=std::hypot(.5*(trial[0]-trial[1]),trial[2]),s1=mean+rad,s2=mean-rad;
      if(fracture && evolve){c.history=std::max(c.history,std::max(0.,s1)/c.E);if(c.history>c.eps0)c.damage=std::max(c.damage,1-c.eps0/c.history*std::exp(-(c.history-c.eps0)/c.softening));}
      const double g=std::max(1e-6,1-c.damage),t1=s1>0 ? g*s1 : s1,t2=s2>0 ? g*s2 : s2,factor=rad>0 ? (t1-t2)/(2*rad) : 0;
      c.stress<<.5*(t1+t2)+factor*.5*(trial[0]-trial[1]),.5*(t1+t2)-factor*.5*(trial[0]-trial[1]),factor*trial[2];
      // Plane strain retains its out-of-plane stress even on the legacy
      // in-plane tensile-damage path. Apply the same positive-stress split.
      const double zz=planeMode==1 ? c.nu*(trial[0]+trial[1]) : 0;
      c.rockState.stress(2,2)=zz>0 ? g*zz : zz;
      localForce[k]=c.area*c.B.transpose()*c.stress;
    }
    if(!rockError.empty())throw std::runtime_error(rockError);
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
    for(const auto& c:cells)if(fracture && (c.rockParameters.law==0 || c.rockParameters.law==2)){
      const double tensile=.5*(c.stress[0]+c.stress[1])+std::hypot(.5*(c.stress[0]-c.stress[1]),c.stress[2]);
      Require(tensile<=c.E*c.eps0*(1+1e-7),"Initial elastic equilibrium already exceeds tensile strength. Pre-damaged static equilibrium is not supported; check confinement/material or disable damage.");
    }
  }else internal(false);
  double preloadEnergy=0;for(auto& c:cells){c.initialStress=c.stress;c.initialZz=c.rockState.stress(2,2);preloadEnergy+=.5*c.area*c.strain.dot(c.stress);}
  for(auto& c:cells)if(c.rockParameters.law!=0 || kinematics==1){
    rock::Initialize(c.rockParameters,c.rockState,c.strain,c.stress,planeMode==1);
    c.initialZz=c.rockState.stress(2,2);
    if(kinematics==1){for(int j=0;j<3;++j){const auto n=c.nodes[j];c.previousF(0,0)+=u[2*n]*c.B(0,2*j);c.previousF(0,1)+=u[2*n]*c.B(1,2*j+1);c.previousF(1,0)+=u[2*n+1]*c.B(0,2*j);c.previousF(1,1)+=u[2*n+1]*c.B(1,2*j+1);}c.initialJacobian=c.currentJacobian=c.previousF.determinant();c.localTimeLimit=baseDt*.25;}
    if(c.rockParameters.law==3)Require(rock::Q(c.rockState.stress)<=rock::Strength(c.rockParameters,c.rockState.initialPressure,0,0)*(1+1e-7) && c.rockState.initialPressure>=-c.rockParameters.T,"Initial equilibrium exceeds JH2 strength; nonlinear static initialization is required.");
    if(c.rockParameters.law==2){
      const double sine=std::sin(c.rockParameters.friction*3.141592653589793/180),alpha=6*sine/(3-sine);
      const double yield=std::max(0.,c.rockParameters.fc*(1-alpha/3)+alpha*c.rockState.initialPressure);
      Require(rock::Q(c.rockState.stress)<=yield+1e-7*std::max(1.,yield),"Initial equilibrium exceeds DP strength; nonlinear static initialization is required.");
    }
  }
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
  auto cavityGeometry=[&](const Eigen::VectorXd& displacement){
    Eigen::VectorXd gradient=Eigen::VectorXd::Zero(nd);
    for(const auto& edge:cavitySegments){const auto aa=std::get<0>(edge),bb=std::get<1>(edge);const double sign=std::get<2>(edge);
      const double dx=model.nodes[bb].x+displacement[2*bb]-model.nodes[aa].x-displacement[2*aa],dy=model.nodes[bb].y+displacement[2*bb+1]-model.nodes[aa].y-displacement[2*aa+1];
      const Eigen::Vector2d force=.5*sign*Eigen::Vector2d(-dy,dx);gradient.segment<2>(2*aa)+=force;gradient.segment<2>(2*bb)+=force;
    }
    double area=0;for(std::size_t i=0;i<nn;++i)area+=.5*gradient.segment<2>(2*i).dot(Eigen::Vector2d(model.nodes[i].x+displacement[2*i],model.nodes[i].y+displacement[2*i+1]));
    return std::make_pair(gradient,area);
  };
  const double initialCavityArea=kinematics==1 ? cavityGeometry(referenceU).second : 0;
  if(gasMode){
    const Eigen::VectorXd initialForce=external+(currentGasPressure-gasParameters.airPressure)*pressureForce-internal(false);
    for(std::size_t i=0;i<nd;++i)if(!fixed[i])a[i]=initialForce[i]/mass[i];
  }
  auto pressure=[&](double t){return gasMode ? currentGasPressure : t>=0 && t<pulse ? peak*std::sin(3.14159265358979323846*t/pulse) : 0.;};
  std::ostringstream metadata;metadata<<std::setprecision(16)<<"{\"nodeCount\":"<<nn<<",\"elementCount\":"<<cells.size()<<",\"frameCount\":"<<frames
    <<",\"dt\":"<<dt<<",\"stableDt\":"<<stableDt<<",\"steps\":"<<steps<<",\"loadedEdges\":"<<loadedEdges<<",\"absorbingEdges\":"<<absorbingEdges
    <<",\"fixedBoundaryEdges\":"<<fixedBoundaryEdges<<",\"preloadResidual\":"<<preloadResidual<<",\"preloadEnergy\":"<<preloadEnergy<<",\"workers\":"<<workers
    <<",\"constitutiveVersion\":2,\"rockModel\":"<<rockModel<<",\"gasFracture\":"<<gasFracture<<",\"kinematics\":"<<kinematics<<",\"gasVentEnds\":"<<ventEnds<<",\"stepCountIsEstimate\":"<<(kinematics==1?"true":"false")<<",\"cellScalarCount\":"<<(advanced ? 10 : 7)
    <<",\"effectiveProductGamma\":"<<(gasParameters.omega+1)<<",\"productEOS\":"<<productEOS<<",\"sourceMode\":"<<sourceMode<<",\"frameScalarCount\":"<<(ventEnds>0 ? 24 : advanced ? 20 : gasMode ? 12 : 8)<<",\"initialGasEnergy\":"<<(gasMode ? gas->InitialEnergy() : 0)<<"}";
  const std::string json=metadata.str();out.write("FEMBLT02",8);Raw(out,static_cast<std::uint32_t>(json.size()));out.write(json.data(),json.size());
  int saved=0;double externalWork=0,dissipated=0;
  std::vector<double> cellOutput(cells.size()*(advanced ? 10 : 7));
  double crackVolume=0,gasStorageWork=0;
  std::vector<double> crackWeights(cells.size(),0);
  Eigen::VectorXd gasForce=pressureForce;
  auto progressAt=std::chrono::steady_clock::now();
  double simulationTime=0;
  for(int step=0;kinematics==1 ? simulationTime<=duration : step<=steps;++step){
    Require(step<20000000,"Finite-deformation step limit reached; severely distorted mesh requires remeshing.");
    const auto now=std::chrono::steady_clock::now();
    if(step==0 || step==steps || now-progressAt>=std::chrono::milliseconds(250)){
      std::cerr<<"BLAST_PROGRESS "<<(kinematics==1 ? std::min(steps,static_cast<int>(simulationTime/duration*steps)) : step)<<" "<<steps<<"\n";progressAt=now;
    }
    const double time=kinematics==1 ? simulationTime : step*dt;
    if(kinematics==1 ? (step==0 || time>=duration*saved/(frames-1)-1e-14) : (step==0 || step==static_cast<int>(std::llround(static_cast<double>(saved)*steps/(frames-1))) || step==steps)){
      double elastic=0,maxStress=0,maxDynamic=0,plasticWork=0,maxStrain=0;
      for(std::size_t i=0;i<cells.size();++i){const auto& c=cells[i];elastic+=c.rockParameters.law!=0 || kinematics==1 ? c.area*rock::StoredEnergy(c.rockParameters,c.rockState) : .5*c.area*c.strain.dot(c.stress);
        if(c.rockParameters.law!=0 || kinematics==1){auto delta=c.rockState.stress;delta(0,0)-=c.initialStress[0];delta(1,1)-=c.initialStress[1];delta(0,1)-=c.initialStress[2];delta(1,0)-=c.initialStress[2];delta(2,2)-=c.initialZz;
          maxStress=std::max(maxStress,rock::Q(c.rockState.stress));maxDynamic=std::max(maxDynamic,rock::Q(delta));
        }else {maxStress=std::max(maxStress,Equivalent(c.stress,c.rockState.stress(2,2)));maxDynamic=std::max(maxDynamic,Equivalent(c.stress-c.initialStress,c.rockState.stress(2,2)-c.initialZz));}
        plasticWork+=c.area*c.rockState.plasticWork;maxStrain=std::max(maxStrain,std::sqrt(std::max(0.,c.strain[0]*c.strain[0]-c.strain[0]*c.strain[1]+c.strain[1]*c.strain[1]+.75*c.strain[2]*c.strain[2])));
        const double values[10]={c.strain[0],c.strain[1],c.strain[2],c.stress[0],c.stress[1],c.stress[2],c.damage,c.rockState.stress(2,2),c.rockState.plasticStrain,c.rockState.plasticWork};
        std::copy(values,values+(advanced ? 10 : 7),cellOutput.begin()+i*(advanced ? 10 : 7));}
      const std::array<double,8> info={time,pressure(time),.5*(mass.array()*v.array().square()).sum(),elastic,externalWork,dissipated,maxStress,maxDynamic};
      out.write(reinterpret_cast<const char*>(info.data()),sizeof(info));
      if(gasMode || advanced){const auto state=gasMode ? gas->Snapshot() : GasSnapshot{};const std::array<double,4> extra={state.internalEnergy,state.kineticEnergy,state.wallWork,state.radius};out.write(reinterpret_cast<const char*>(extra.data()),sizeof(extra));}
      if(advanced){const std::array<double,4> extra={plasticWork,crackVolume,gasStorageWork,maxStrain};out.write(reinterpret_cast<const char*>(extra.data()),sizeof(extra));
        double minJ=1,maxCfl=0;for(const auto& c:cells){minJ=std::min(minJ,c.currentJacobian);if(kinematics==1)maxCfl=std::max(maxCfl,dt/c.localTimeLimit);}
        const std::array<double,4> diagnostics={static_cast<double>(step),minJ,gasMode ? static_cast<double>(gas->Snapshot().rarefactionFallbacks) : 0,maxCfl};out.write(reinterpret_cast<const char*>(diagnostics.data()),sizeof(diagnostics));
      }
      if(ventEnds>0){const auto state=gasMode?gas->Snapshot():GasSnapshot{};const std::array<double,4> extra={state.ventedMass,state.ventedEnergy,state.productMass,state.airMass};out.write(reinterpret_cast<const char*>(extra.data()),sizeof(extra));}
      out.write(reinterpret_cast<const char*>(u.data()),nd*sizeof(double));out.write(reinterpret_cast<const char*>(v.data()),nd*sizeof(double));
      out.write(reinterpret_cast<const char*>(cellOutput.data()),cellOutput.size()*sizeof(double));
      out.flush();Require(out.good(),"Failed writing streamed blast frame.");++saved;
    }
    if(kinematics==1 ? time>=duration-1e-15 : step==steps)break;
    if(kinematics==1){dt=baseDt;for(const auto& c:cells)dt=std::min(dt,c.localTimeLimit);dt=std::min(dt,duration*saved/(frames-1)-time);Require(dt>1e-14,"Finite-deformation CFL step collapsed; use remeshing or a particle solver.");}
    const Eigen::VectorXd oldU=u,oldV=v;
    u+=dt*v+(.5*dt*dt)*a;v+=(.5*dt)*a;
    double gasAverage=0;
    if(gasMode){
      // Small-strain area change is integral(u.n ds). Mapping it to pi R^2
      // makes the radial fluid's wall-volume work match the solid interface work.
      gasForce=pressureForce;double topologyVolume=0;crackVolume=0;
      if(kinematics==1)gasForce=cavityGeometry((.5*(u+oldU)).eval()).first;
      if(gasFracture==1){
        std::vector<bool> connected(cells.size(),false);std::vector<std::size_t> queue;
        for(std::size_t k=0;k<cells.size();++k)if(cells[k].cavityCell && cells[k].damage>=crackDamage){connected[k]=true;queue.push_back(k);}
        for(std::size_t j=0;j<queue.size();++j)for(auto k:cells[queue[j]].neighbours)if(!connected[k] && cells[k].damage>=crackDamage){connected[k]=true;queue.push_back(k);}
        for(std::size_t k=0;k<cells.size();++k){const auto& c=cells[k];if(!connected[k])continue;
          V6 next,previous;for(int j=0;j<6;++j){const auto d=2*c.nodes[j/2]+j%2;next[j]=u[d]-referenceU[d];previous[j]=oldU[d]-referenceU[d];}
          Eigen::Matrix<double,1,6> gradient=c.B.row(0)+c.B.row(1);double opening=gradient.dot(next),oldOpening=gradient.dot(previous);const double weight=c.damage;
          if(kinematics==1){
            Eigen::Matrix2d Fn=Eigen::Matrix2d::Identity(),Fo=Fn;
            for(int j=0;j<3;++j){const auto n=c.nodes[j];const Eigen::RowVector2d g(c.B(0,2*j),c.B(1,2*j+1));Fn+=u.segment<2>(2*n)*g;Fo+=oldU.segment<2>(2*n)*g;}
            opening=Fn.determinant()-c.initialJacobian;oldOpening=Fo.determinant()-c.initialJacobian;
            const Eigen::Matrix2d Fmid=.5*(Fn+Fo),cofactor=Fmid.determinant()*Fmid.inverse().transpose();
            for(int j=0;j<3;++j){const Eigen::Vector2d g=cofactor*Eigen::Vector2d(c.B(0,2*j),c.B(1,2*j+1));gradient[2*j]=g[0];gradient[2*j+1]=g[1];}
          }
          crackVolume+=c.area*weight*std::max(0.,opening);
          topologyVolume+=c.area*(weight-crackWeights[k])*std::max(0.,oldOpening);
          // Secant derivative makes force work equal the change in unilateral
          // storage volume for fixed damage, even when a crack closes.
          const double ratio=std::abs(opening-oldOpening)>1e-16 ? (std::max(0.,opening)-std::max(0.,oldOpening))/(opening-oldOpening) : opening>0 ? 1 : 0;
          for(int j=0;j<6;++j)gasForce[2*c.nodes[j/2]+j%2]+=c.area*weight*ratio*gradient[j];
          crackWeights[k]=weight;
        }
      }
      const double wallArea=3.14159265358979323846*radius*radius+(kinematics==1 ? cavityGeometry(u).second-initialCavityArea : pressureForce.dot(u-referenceU))+crackVolume;
      Require(wallArea>0,"Mean cavity area collapsed in gas coupling.");
      gasAverage=gas->Advance(time+dt,std::sqrt(wallArea/3.14159265358979323846));
      gasStorageWork+=gasAverage*topologyVolume;
      currentGasPressure=gas->WallPressure();
    }
    const double forcingPressure=gasMode ? gasAverage-gasParameters.airPressure : pressure(time+dt);
    Eigen::VectorXd applied=forcingPressure*pressureForce;
    if(gasMode)applied=gasAverage*gasForce-gasParameters.airPressure*pressureForce;
    const Eigen::VectorXd force=external+applied-internal(true);
    #pragma omp parallel for num_threads(workers) if(workers>1)
    for(int i=0;i<static_cast<int>(nn);++i){
      if(kinematics==1){Eigen::Matrix2d lhs=mass[2*i]*Eigen::Matrix2d::Identity()+.5*dt*dashpot[i];for(int axis=0;axis<2;++axis)if(fixed[2*i+axis]){lhs.row(axis).setZero();lhs.col(axis).setZero();lhs(axis,axis)=1;}inverseMass[i]=lhs.inverse();}
      Eigen::Vector2d rhs=force.segment<2>(2*i)-dashpot[i]*v.segment<2>(2*i);
      for(int axis=0;axis<2;++axis)if(fixed[2*i+axis])rhs[axis]=0;
      a.segment<2>(2*i)=inverseMass[i]*rhs;v.segment<2>(2*i)+=.5*dt*a.segment<2>(2*i);
    }
    Require(u.allFinite() && v.allFinite() && a.allFinite(),"Blast solution diverged; check mesh/material/time step.");
    const double workPressure=gasMode ? gasAverage-gasParameters.airPressure : .5*(pressure(time)+pressure(time+dt));
    Eigen::VectorXd workForce=workPressure*pressureForce;if(gasMode)workForce=gasAverage*gasForce-gasParameters.airPressure*pressureForce;
    externalWork+=(external+workForce).dot(u-oldU);
    for(std::size_t i=0;i<nn;++i)dissipated+=.5*dt*(oldV.segment<2>(2*i).dot(dashpot[i]*oldV.segment<2>(2*i))+v.segment<2>(2*i).dot(dashpot[i]*v.segment<2>(2*i)));
    simulationTime=time+dt;
  }
  out.flush();return 0;
}
}
