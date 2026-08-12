const fs = require('fs');
const path = "pacepack\\src\\js\\app.js";
const content = fs.readFileSync(path, "utf-8");

// Exact match from file
const old = `  const profileBtn = document.getElementById("btn-profile");
  if (profileBtn) profileBtn.onclick = () => setView("profile");

  const signoutButton = document.getElementById("btn-signout");
  if (signoutButton) signoutButton.onclick = () => signOut();`;

console.log("Old found:", content.includes(old));
console.log("---");
console.log("Old chars:", JSON.stringify(old.substring(0, 50)));
console.log("---");
console.log("Line 4654:", JSON.stringify(content.split('\n')[4653]));