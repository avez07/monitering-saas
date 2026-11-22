import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';

/** Yukti platform admin (/admin/*). Rendered inside AdminShell, staff only (see routes.jsx). */
const Overview = lazy(() => import('./Overview'));
const Orgs = lazy(() => import('./Orgs'));
const OrgDetail = lazy(() => import('./OrgDetail'));
const Users = lazy(() => import('./Users'));
const Audit = lazy(() => import('./Audit'));

export default function AdminPages() {
  return (
    <Routes>
      <Route index element={<Overview />} />
      <Route path="orgs" element={<Orgs />} />
      <Route path="orgs/:id" element={<OrgDetail />} />
      <Route path="users" element={<Users />} />
      <Route path="audit" element={<Audit />} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
