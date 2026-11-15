import { Route, Routes } from 'react-router-dom';
import WebsiteList from './WebsiteList';
import WebsiteDetail from './WebsiteDetail';

export default function Websites() {
  return (
    <Routes>
      <Route index element={<WebsiteList />} />
      <Route path=":id" element={<WebsiteDetail />} />
      <Route path="*" element={<WebsiteList />} />
    </Routes>
  );
}
