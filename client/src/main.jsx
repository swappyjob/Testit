import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './styles.css';
import { ConfirmProvider } from './confirm.jsx';

import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import Reset from './pages/Reset.jsx';
import StudentDashboard from './pages/StudentDashboard.jsx';
import TakeTest from './pages/TakeTest.jsx';
import StudentReview from './pages/StudentReview.jsx';
import TeacherDashboard from './pages/TeacherDashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';
import SupportDashboard from './pages/SupportDashboard.jsx';

const teacherLogin = {
  role: 'teacher', title: 'Teacher login',
  subtitle: "Teachers are created by an administrator or a root teacher. Ask them for a signup link if you don't have an account yet.",
  footer: <><a href="/forgot-password">Forgot password?</a><br />Are you a student? <a href="/student-login">Student login</a></>,
};
const studentLogin = {
  role: 'student', title: 'Student login',
  subtitle: 'Log in with the email your teacher used to invite you.',
  footer: <><a href="/forgot-password">Forgot password?</a><br />Are you a teacher? <a href="/teacher-login">Teacher login</a></>,
};
const adminLogin = {
  role: 'admin', title: 'Admin login', subtitle: 'Platform administrator sign-in.',
  footer: <a href="/forgot-password">Forgot password?</a>,
};
const supportLogin = {
  role: 'support', title: 'Support login', subtitle: 'Support-team sign-in.',
  footer: <a href="/forgot-password">Forgot password?</a>,
};
// The homepage is one clean login for everyone — the server detects the role
// (teacher / student / admin / support) and routes to the right dashboard.
const homeLogin = {
  title: 'Log in', subtitle: 'Sign in to your account.',
  footer: <a href="/forgot-password">Forgot password?</a>,
};

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfirmProvider>
      <Routes>
        <Route path="/" element={<Login {...homeLogin} />} />
        <Route path="/teacher-login" element={<Login {...teacherLogin} />} />
        <Route path="/student-login" element={<Login {...studentLogin} />} />
        <Route path="/admin-login" element={<Login {...adminLogin} />} />
        <Route path="/support-login" element={<Login {...supportLogin} />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/student" element={<StudentDashboard />} />
        <Route path="/take-test" element={<TakeTest />} />
        <Route path="/review" element={<StudentReview />} />
        <Route path="/teacher" element={<TeacherDashboard />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/support" element={<SupportDashboard />} />
        <Route path="*" element={<Login {...homeLogin} />} />
      </Routes>
      </ConfirmProvider>
    </BrowserRouter>
  </React.StrictMode>
);
