// MFEM 4.10 reference excerpt; not a standalone compilation unit.
// Copyright (c) 2010-2026, Lawrence Livermore National Security, LLC.
// BSD-3-Clause. See ../LICENSE and ../NOTICE.

real_t ZZErrorEstimator(BilinearFormIntegrator &blfi,
                        GridFunction &u,
                        GridFunction &flux, Vector &error_estimates,
                        Array<int>* aniso_flags,
                        int with_subdomains,
                        bool with_coeff)
{
   FiniteElementSpace *ufes = u.FESpace();
   FiniteElementSpace *ffes = flux.FESpace();
   ElementTransformation *Transf;
   DofTransformation utrans, ftrans;

   int dim = ufes->GetMesh()->Dimension();
   int nfe = ufes->GetNE();

   Array<int> udofs;
   Array<int> fdofs;
   Vector ul, fl, fla, d_xyz;

   error_estimates.SetSize(nfe);
   if (aniso_flags)
   {
      aniso_flags->SetSize(nfe);
      d_xyz.SetSize(dim);
   }

   int nsd = 1;
   if (with_subdomains)
   {
      nsd = ufes->GetMesh()->attributes.Max();
   }

   real_t total_error = 0.0;
   for (int s = 1; s <= nsd; s++)
   {
      // This calls the parallel version when u is a ParGridFunction
      u.ComputeFlux(blfi, flux, with_coeff, (with_subdomains ? s : -1));

      for (int i = 0; i < nfe; i++)
      {
         if (with_subdomains && ufes->GetAttribute(i) != s) { continue; }

         ufes->GetElementVDofs(i, udofs, utrans);
         ffes->GetElementVDofs(i, fdofs, ftrans);

         u.GetSubVector(udofs, ul);
         flux.GetSubVector(fdofs, fla);
         utrans.InvTransformPrimal(ul);
         ftrans.InvTransformPrimal(fla);

         Transf = ufes->GetElementTransformation(i);
         blfi.ComputeElementFlux(*ufes->GetFE(i), *Transf, ul,
                                 *ffes->GetFE(i), fl, with_coeff);

         fl -= fla;

         real_t eng = blfi.ComputeFluxEnergy(*ffes->GetFE(i), *Transf, fl,
                                             (aniso_flags ? &d_xyz : NULL));

         error_estimates(i) = std::sqrt(eng);
         total_error += eng;

         if (aniso_flags)
         {
            real_t sum = 0;
            for (int k = 0; k < dim; k++)
            {
               sum += d_xyz[k];
            }

            real_t thresh = 0.15 * 3.0/dim;
            int flag = 0;
            for (int k = 0; k < dim; k++)
            {
               if (d_xyz[k] / sum > thresh) { flag |= (1 << k); }
            }

            (*aniso_flags)[i] = flag;
         }
      }
   }
#ifdef MFEM_USE_MPI
   auto pfes = dynamic_cast<ParFiniteElementSpace*>(ufes);
   if (pfes)
   {
      auto process_local_error = total_error;
      MPI_Allreduce(&process_local_error, &total_error, 1,
                    MPITypeMap<real_t>::mpi_type,
                    MPI_SUM, pfes->GetComm());
   }
#endif // MFEM_USE_MPI
   return std::sqrt(total_error);
}

