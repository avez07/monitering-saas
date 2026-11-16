import { Navigate, Route, Routes } from 'react-router-dom';
import Connect from './Connect';
import Logs from './Logs';
import ServiceDetail from './ServiceDetail';
import ServiceList from './ServiceList';
import TraceDetail from './TraceDetail';
import Traces from './Traces';

export default function Apps() {
  return (
    <Routes>
      <Route index element={<ServiceList />} />
      <Route path="services/:name" element={<ServiceDetail />} />
      <Route path="traces" element={<Traces />} />
      <Route path="traces/:id" element={<TraceDetail />} />
      <Route path="logs" element={<Logs />} />
      <Route path="connect" element={<Connect />} />
      <Route path="*" element={<Navigate to="/apps" replace />} />
    </Routes>
  );
}
