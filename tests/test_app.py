import unittest

from fastapi.testclient import TestClient

from app.main import create_app


class AppSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app())

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_login_page_renders(self):
        response = self.client.get("/login")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Sign in", response.text)

    def test_protected_page_redirects(self):
        response = self.client.get("/", follow_redirects=False)
        self.assertIn(response.status_code, {303, 307, 302})
        self.assertEqual(response.headers["location"], "/login")
