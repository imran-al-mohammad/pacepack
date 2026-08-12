const fs = require('fs');
const path = "pacepack\\src\\js\\app.js";
const content = fs.readFileSync(path, "utf-8");

const old = `  if (profileBtn) profileBtn.onclick = () => setView("profile");

  const signoutButton = document.getElementById("btn-signout");
  if (signoutButton) signoutButton.onclick = () => signOut();`;

const newCode = `  if (profileBtn) {
    profileBtn.onclick = (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById("profileDropdown");
      if (dropdown) {
        dropdown.hidden = !dropdown.hidden;
        // Close any other open dropdowns
        document.querySelectorAll(".profile-dropdown").forEach((d) => {
          if (d !== dropdown) d.hidden = true;
        });
      }
    };
  }

  const signoutButton = document.getElementById("btn-signout");
  if (signoutButton) signoutButton.onclick = () => signOut();`;

if (content.includes(old)) {
    content = content.replace(old, newCode);
    fs.writeFileSync(path, content);
    console.log("Replacement successful");
} else {
    console.log("Old string not found");
    const lines = content.split("\n");
    for (let i = 4653; i < 4660; i++) {
        console.log(`${i}: ${JSON.stringify(lines[i])}`);
    }
}