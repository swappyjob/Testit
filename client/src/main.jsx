import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './styles.css';

import Landing from './pages/Landing.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import Reset from './pages/Reset.jsx';
import StudentDashboard from './pages/StudentDashboard.jsx';
import TakeTest from './pages/TakeTest.jsx';
import TeacherDashboard from './pages/TeacherDashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';

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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/teacher-login" element={<Login {...teacherLogin} />} />
        <Route path="/student-login" element={<Login {...studentLogin} />} />
        <Route path="/admin-login" element={<Login {...adminLogin} />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset" element={<Reset />} />
        <Route path="/student" element={<StudentDashboard />} />
        <Route path="/take-test" element={<TakeTest />} />
        <Route path="/teacher" element={<TeacherDashboard />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
