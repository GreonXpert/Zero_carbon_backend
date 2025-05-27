const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./config/db");
const path = require("path");
const http   = require("http");
const socketIo = require("socket.io")

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
const processFlowR = require("./router/processflowR");
const dataEntryRoutes = require('./router/dataEntryRoutes');
const EmissionFactorScope3Routes = require('./router/EmissionFactorScope3Routes');

dotenv.config();

const app = express();

// Middleware
app.use(express.json());

// 2. Global request logger — logs *every* incoming request
app.use((req, res, next) => {
    console.log(`\n[${new Date().toISOString()}] ➜ ${req.method} ${req.originalUrl}`);
    console.log("  Params:", req.params);
    console.log("  Query :", req.query);
    console.log("  Body  :", req.body);
    next();
  });

// ——————————— Debug logging for our calculate route ———————————
app.use('/api/calculate-emission', (req, res, next) => {
      console.log(
        `[${new Date().toISOString()}] → calculate-emission ${req.method}`,
        '\nBody:', req.body
      );
      next();
    });
app.use(cors({
    origin: ["http://localhost:3000"],
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
// app.use("/api", CalculationDataOfEmissionC02eRouter);
app.use("/api", CalculateEmissionCO2eRouter);
app.use("/api", TotalEmissionCO2eControllerRouter);
app.use("/api", CalculationOfElectricityRouter);
app.use("/api", TotalEmissionElectricityRouter);
app.use("/api/processflow", processFlowR);
app.use('/api/data-entry', dataEntryRoutes);
app.use('/api/scope3-emission-factors', EmissionFactorScope3Routes);



// Create HTTP server and bind Socket.io
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ["http://localhost:3000", "https://api.zerohero.ebhoom.com", "https://zerotohero.ebhoom.com"],
    credentials: true
  }
});
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  // (You could add event handlers here if clients emit events)
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Make io globally accessible (for use in controllers)
global.io = io;

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
