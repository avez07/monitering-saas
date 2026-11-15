import { Navigate, Route, Routes } from 'react-router-dom';
import ServerList from './ServerList';
import ServerDetail from './ServerDetail';

export default function Servers() {
  return (
    <Routes>
      <Route index element={<ServerList />} />
      <Route path=":id/*" element={<ServerDetail />} />
      <Route path="*" element={<Navigate to="/servers" replace />} />
    </Routes>
  );
}
