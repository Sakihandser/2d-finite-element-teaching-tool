// MFEM 4.10 reference excerpt; not a standalone compilation unit.
// Copyright (c) 2010-2026, Lawrence Livermore National Security, LLC.
// BSD-3-Clause. See ../LICENSE and ../NOTICE.

real_t ElasticityIntegrator::ComputeFluxEnergy(const FiniteElement &fluxelem,
                                               ElementTransformation &Trans,
                                               Vector &flux, Vector *d_energy)
{
   const int dof = fluxelem.GetDof();
   const int dim = fluxelem.GetDim();
   const int tdim = dim*(dim+1)/2; // num. entries in a symmetric tensor
   real_t L, M;

   // The MFEM_ASSERT constraints in ElasticityIntegrator::ComputeElementFlux
   // are assumed here too.
   MFEM_ASSERT(d_energy == NULL, "anisotropic estimates are not supported");
   MFEM_ASSERT(flux.Size() == dof*tdim, "invalid 'flux' vector");

#ifndef MFEM_THREAD_SAFE
   shape.SetSize(dof);
#else
   Vector shape(dof);
#endif
   real_t pointstress_data[6];
   Vector pointstress(pointstress_data, tdim);

   // View of the 'flux' vector as a (dof x tdim) matrix
   DenseMatrix flux_mat(flux.GetData(), dof, tdim);

   // Use the same integration rule as in AssembleElementMatrix, replacing 'el'
   // with 'fluxelem' when 'IntRule' is not set.
   // Should we be using a different (more accurate) rule here?

   const IntegrationRule *ir = GetIntegrationRule(fluxelem, Trans);
   if (ir == NULL)
   {
      int order = 2 * Trans.OrderGrad(&fluxelem);
      ir = &IntRules.Get(fluxelem.GetGeomType(), order);
   }

   real_t energy = 0.0;

   for (int i = 0; i < ir->GetNPoints(); i++)
   {
      const IntegrationPoint &ip = ir->IntPoint(i);
      Trans.SetIntPoint(&ip);
      fluxelem.CalcPhysShape(Trans, shape);

      flux_mat.MultTranspose(shape, pointstress);

      real_t w = Trans.Weight() * ip.weight;

      M = mu->Eval(Trans, ip);
      if (lambda)
      {
         L = lambda->Eval(Trans, ip);
      }
      else
      {
         L = q_lambda * M;
         M = q_mu * M;
      }

      // The strain energy density at a point is given by (1/2)*(s : e) where s
      // and e are the stress and strain tensors, respectively. Since we only
      // have the stress, we need to compute the strain from the stress:
      //    s = 2*mu*e + lambda*tr(e)*I
      // Taking trace on both sides we find:
      //    tr(s) = 2*mu*tr(e) + lambda*tr(e)*dim = (2*mu + dim*lambda)*tr(e)
      // which gives:
      //    tr(e) = tr(s)/(2*mu + dim*lambda)
      // Then from the first identity above we can find the strain:
      //    e = (1/(2*mu))*(s - lambda*tr(e)*I)

      real_t pt_e; // point strain energy density
      const real_t *s = pointstress_data;
      if (dim == 2)
      {
         // s entries: s_xx, s_yy, s_xy
         const real_t tr_e = (s[0] + s[1])/(2*(M + L));
         L *= tr_e;
         pt_e = (0.25/M)*(s[0]*(s[0] - L) + s[1]*(s[1] - L) + 2*s[2]*s[2]);
      }
      else // (dim == 3)
      {
         // s entries: s_xx, s_yy, s_zz, s_xy, s_xz, s_yz
         const real_t tr_e = (s[0] + s[1] + s[2])/(2*M + 3*L);
         L *= tr_e;
         pt_e = (0.25/M)*(s[0]*(s[0] - L) + s[1]*(s[1] - L) + s[2]*(s[2] - L) +
                          2*(s[3]*s[3] + s[4]*s[4] + s[5]*s[5]));
      }

      energy += w * pt_e;
   }
   return energy;
}

