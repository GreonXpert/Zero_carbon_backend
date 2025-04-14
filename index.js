const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./config/db");
const path = require("path");

// Import Routes
const userR = require("./router/userR");
const adminR = require("./router/adminR");
const authR = require("./router/authR");
const flowchartR = require("./router/flowchartR");
const EmissionFactorRoute = require("./router/EmissionFactor");
const gwpRoutes = require("./router/gwpRoutes");
const fuelCombustionRoutes = require("./router/fuelCombustionRoutes");
const CountryemissionFactorRouter = require("./router/countryemissionFactorRouter");
const CalculationDataOfEmissionC02eRouter = require("./router/CalculationDataOfEmissionC02eRoute");
const CalculateEmissionCO2eRouter = require("./router/CalculateEmissionCO2eRoute");
const TotalEmissionCO2eControllerRouter = require("./router/TotalEmissionCO2eControllerRoute");
const CalculationOfElectricityRouter = require("./router/CalculationOfElectricityRouter");
const TotalEmissionElectricityRouter = require("./router/TotalEmissionElectricityRouter");

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors({
    origin: ["http://localhost:3000", "https://api.zerohero.ebhoom.com", "https://zerotohero.ebhoom.com"],
    credentials: true,
}));

// Routes
app.use("/api/user", userR);
app.use("/api/admin", adminR);
app.use("/api/auth", authR);
app.use("/api/flowchart", flowchartR);
app.use("/api", EmissionFactorRoute);
app.use("/api/gwp", gwpRoutes);
app.use("/api/fuelCombustion", fuelCombustionRoutes);
app.use("/api/country-emission-factors", CountryemissionFactorRouter);
app.use("/api", CalculationDataOfEmissionC02eRouter);
app.use("/api", CalculateEmissionCO2eRouter);
app.use("/api", TotalEmissionCO2eControllerRouter);
app.use("/api", CalculationOfElectricityRouter);
app.use("/api", TotalEmissionElectricityRouter);

// Connect to Database
connectDB();

// Import and initialize admin account from environment variables
const { initializeAdminAccount } = require("./controllers/userController");
initializeAdminAccount();

// Optionally, if you wish to serve static files, you can uncomment the following section
// app.use(express.static(path.join(__dirname, "build")));
// app.get("*", (req, res) => {
//     res.sendFile(path.join(__dirname, "build", "index.html"));
// });

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
