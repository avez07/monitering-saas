import { Navigate, Route, Routes } from 'react-router-dom';
import ContainerList from './ContainerList';
import ContainerDetail from './ContainerDetail';

export default function Containers() {
  return (
    <Routes>
      <Route index element={<ContainerList />} />
      <Route path=":id/*" element={<ContainerDetail />} />
      <Route path="*" element={<Navigate to="/containers" replace />} />
    </Routes>
  );
}
