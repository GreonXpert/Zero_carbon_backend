
ZeroCarbon Backend Architecture - GreonXpert
===========================================

bcknd-zerocarbon/
├── config/
│   └── db.js                 # Database connection configuration
├── controllers/
│   ├── Calculation/
│   │   ├── CalculationSummary.js # Logic for creating emission summaries
│   │   ├── emissionCalculationController.js # Core emission calculation logic
│   │   └── emissionIntegration.js # Integrates data entry with calculations
│   ├── DataCollection/
│   │   └── monthlyDataSummaryController.js # Handles monthly data aggregation
│   ├── EmissionFactor/
│   │   ├── countryEmissionFactorController.js # Manages country-specific emission factors
│   │   ├── DefraDataController.js  # Manages DEFRA emission factors
│   │   ├── EmissionFactorHubController.js # Manages custom emission factors
│   │   ├── EPADataController.js    # Manages EPA emission factors
│   │   ├── fuelCombustionController.js # Manages fuel combustion emission factors
│   │   └── ipccDataController.js   # Manages IPCC emission factors
│   ├── clientController.js       # Handles client and lead management
│   ├── dataCollectionController.js # Manages data entry from various sources
│   ├── flowchartController.js    # Manages organizational flowcharts
│   ├── gwpController.js          # Manages Global Warming Potential data
│   ├── iotController.js          # Handles IoT data ingestion
│   ├── notificationControllers.js # Manages user notifications
│   ├── processflowController.js  # Manages process-level flowcharts
│   └── userController.js         # Handles user authentication and management
├── middleware/
│   ├── auth.js                 # Authentication and authorization middleware
│   └── compression.js          # Compresses HTTP responses
├── migration/
│   ├── addWorkflowTracking.js  # Script to update existing clients with workflow fields
│   └── fix-emission-summary-index.js # Script to fix database indexes
├── models/
│   ├── CalculationEmission/
│   │   └── EmissionSummary.js    # Schema for emission summaries
│   ├── EmissionFactor/
│   │   ├── contryEmissionFactorModel.js # Schema for country emission factors
│   │   ├── DefraData.js          # Schema for DEFRA data
│   │   ├── EmissionFactorHub.js  # Schema for custom emission factors
│   │   ├── EPAData.js            # Schema for EPA data
│   │   ├── FuelCombustion.js     # Schema for fuel combustion data
│   │   └── IPCCData.js           # Schema for IPCC data
│   ├── Boundary.js             # Schema for organizational boundaries
│   ├── Client.js               # Schema for client data
│   ├── DataCollectionConfig.js # Schema for data collection configurations
│   ├── DataEntry.js            # Schema for individual data entries
│   ├── Flowchart.js            # Schema for organizational flowcharts
│   ├── GWP.js                  # Schema for Global Warming Potential data
│   ├── IOTData.js              # Schema for raw IoT data
│   ├── LiveEmissionEntry.js    # Schema for real-time emission entries
│   ├── Notification.js         # Schema for user notifications
│   ├── ProcessFlowchart.js     # Schema for process flowcharts
│   └── User.js                 # Schema for user accounts
├── mqtt/
│   └── mqttSubscriber.js       # Subscribes to MQTT topics for IoT data
├── router/
│   ├── EmissionFactor/
│   │   ├── countryemissionFactorRouter.js
│   │   ├── defraData.js
│   │   ├── EmissionFactorHubRoutes.js
│   │   ├── EPADataRoutes.js
│   │   ├── fuelCombustionRoutes.js
│   │   └── ipccDataRoutes.js
│   ├── clientR.js              # Routes for client management
│   ├── dataCollectionRoutes.js # Routes for data collection
│   ├── dataEntryRoutes.js      # Routes for data entry
│   ├── emissionRoutes.js       # Routes for emission calculations
│   ├── flowchartR.js           # Routes for flowchart management
│   ├── gwpRoutes.js            # Routes for GWP data management
│   ├── iotRoutes.js            # Routes for IoT data
│   ├── notificationRoutes.js   # Routes for notifications
│   ├── processflowR.js         # Routes for process flowcharts
│   └── userR.js                # Routes for user management
├── test/
│   └── testIoTSystem.js        # Test script for the IoT system
├── uploads/
│   ├── documents/              # Stores uploaded documents
│   └── temp/                   # Temporary storage for uploads
├── utils/
│   ├── authenticate.js         # Authentication utility
│   ├── chart/
│   │   └── chartHelpers.js       # Helper functions for flowcharts
│   ├── DataCollection/
│   │   └── dataCollection.js     # Helper functions for data collection
│   ├── Permissions/
│   │   ├── permissions.js        # Permission checking functions
│   │   └── summaryPermission.js  # Permissions for accessing summaries
│   ├── Workflow/
│   │   └── workflow.js           # Workflow management functions
│   ├── dashboardEmitter.js     # Emits real-time dashboard updates
│   ├── emailHelper.js          # Helper for sending specific emails
│   ├── emailQueue.js           # Queues emails for sending
│   ├── gwpHelper.js            # Helper for GWP calculations
│   ├── mail.js                 # Core email sending functionality
│   ├── multer.js               # Configuration for file uploads
│   └── queueUtils.js           # Utilities for managing queues
├── .env                        # Environment variables
├── .gitignore                  # Files to ignore in Git
├── index.js                    # Main application entry point
├── package.json                # Project dependencies and scripts
└── package-lock.json           # Exact versions of dependencies

Key Features:
- Real-time IoT data processing via MQTT
- Multi-scope emission calculations (Scope 1, 2, 3)
- Support for multiple emission factor databases
- Advanced authentication and permission systems
- Comprehensive data collection and analysis tools
- Enterprise-grade scalability and security

Technology Stack:
- Backend: Node.js + Express.js
- Database: MongoDB
- Authentication: JWT
- IoT: MQTT Protocol
- File Processing: Multer
- Email: Queued processing system

GreonXpert - Innovating Sustainable Solutions
