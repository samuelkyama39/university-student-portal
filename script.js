
// STUDENT LOGIN

const loginForm = document.getElementById("loginForm");

if (loginForm) {
    loginForm.addEventListener("submit", function(event) {

        event.preventDefault();

        const regNo = document.getElementById("regNo").value.trim();
        const password = document.getElementById("password").value;

        if (regNo === "BIT/001/2026" && password === "12345") {

            alert("Login successful!");

            window.location.href = "dashboard.html";

        } else {

            alert("Invalid registration number or password!");

        }

    });
}

// UNIT REGISTRATION

const registerButtons = document.querySelectorAll(".register-btn");

registerButtons.forEach(function(button) {

    button.addEventListener("click", function() {

        if (button.textContent.trim() === "Register") {

            button.textContent = "Registered";
            button.style.background = "#16834a";

            document.getElementById("unitMessage").textContent =
                "Unit registered successfully!";

        } else {

            button.textContent = "Register";
            button.style.background = "#123c69";

            document.getElementById("unitMessage").textContent =
                "Unit registration cancelled.";

        }

    });

});