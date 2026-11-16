import { Route, Routes } from 'react-router-dom';
import ServiceDetail from './ServiceDetail';
import ServiceList from './ServiceList';

export default function Services() {
  return (
    <Routes>
      <Route index element={<ServiceList />} />
      <Route path=":id" element={<ServiceDetail />} />
      <Route path="*" element={<ServiceList />} />
    </Routes>
  );
}
