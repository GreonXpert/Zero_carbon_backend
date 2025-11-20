// models/ClientSandbox.js
const mongoose = require('mongoose');

const DataFlowStepSchema = new mongoose.Schema({
  stepId: { type: String, required: true },
  stepName: { type: String, required: true },
  stepType: { 
    type: String, 
    enum: ['data_collection', 'calculation', 'validation', 'aggregation', 'reporting'],
    required: true 
  },
  inputSources: [{
    sourceId: String,
    sourceName: String,
    sourceType: { type: String, enum: ['manual', 'API', 'IOT', 'flowchart', 'process'] }
  }],
  calculations: [{
    calculationType: String,
    formula: String,
    parameters: mongoose.Schema.Types.Mixed,
    result: Number
  }],
  outputData: mongoose.Schema.Types.Mixed,
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'completed', 'error'],
    default: 'pending' 
  },
  executedAt: Date,
  executionTime: Number, // in milliseconds
  order: { type: Number, required: true }
});

const EmissionMonitoringSchema = new mongoose.Schema({
  scope: { 
    type: String, 
    enum: ['Scope 1', 'Scope 2', 'Scope 3'],
    required: true 
  },
  scopeIdentifier: { type: String, required: true },
  nodeId: String,
  nodeName: String,
  
  // Real-time monitoring data
  currentEmissions: {
    CO2e: { type: Number, default: 0 },
    CO2: { type: Number, default: 0 },
    CH4: { type: Number, default: 0 },
    N2O: { type: Number, default: 0 },
    unit: { type: String, default: 'tCO2e' }
  },
  
  // Trend data
  trends: [{
    timestamp: Date,
    value: Number,
    period: String // daily, weekly, monthly
  }],
  
  // Targets vs Actual
  targets: {
    monthly: Number,
    quarterly: Number,
    yearly: Number
  },
  actual: {
    monthly: Number,
    quarterly: Number,
    yearly: Number
  },
  
  // Alerts and thresholds
  thresholds: {
    warning: Number,
    critical: Number
  },
  alerts: [{
    alertType: { type: String, enum: ['warning', 'critical', 'info'] },
    message: String,
    triggeredAt: Date,
    resolved: { type: Boolean, default: false }
  }],
  
  lastUpdated: { type: Date, default: Date.now }
});

const FlowchartVisualizationSchema = new mongoose.Schema({
  chartType: { 
    type: String, 
    enum: ['organization', 'process', 'transport', 'reduction', 'decarbonization'],
    required: true 
  },
  
  // Reference to actual flowchart
  flowchartId: { type: mongoose.Schema.Types.ObjectId },
  chartName: String,
  
  // Visualization data
  nodes: [{
    id: String,
    label: String,
    type: String,
    position: { x: Number, y: Number },
    data: mongoose.Schema.Types.Mixed,
    emissions: {
      current: Number,
      target: Number,
      percentage: Number
    }
  }],
  
  edges: [{
    id: String,
    source: String,
    target: String,
    label: String,
    data: mongoose.Schema.Types.Mixed
  }],
  
  // Statistics for this chart
  statistics: {
    totalNodes: { type: Number, default: 0 },
    totalScopes: { type: Number, default: 0 },
    totalEmissions: { type: Number, default: 0 },
    dataCompleteness: { type: Number, default: 0 } // percentage
  },
  
  status: { 
    type: String, 
    enum: ['draft', 'in_review', 'approved', 'active'],
    default: 'draft' 
  },
  
  createdAt: { type: Date, default: Date.now },
  lastModified: { type: Date, default: Date.now }
});

const ReductionVisualizationSchema = new mongoose.Schema({
  // Baseline data
  baseline: {
    year: Number,
    totalEmissions: Number,
    scope1: Number,
    scope2: Number,
    scope3: Number
  },
  
  // Current status
  current: {
    year: Number,
    totalEmissions: Number,
    scope1: Number,
    scope2: Number,
    scope3: Number,
    reductionPercentage: Number
  },
  
  // Reduction initiatives
  initiatives: [{
    initiativeId: String,
    name: String,
    category: String,
    targetReduction: Number,
    achievedReduction: Number,
    status: { type: String, enum: ['planned', 'in_progress', 'completed', 'on_hold'] },
    startDate: Date,
    completionDate: Date
  }],
  
  // Year-over-year comparison
  yearlyData: [{
    year: Number,
    totalEmissions: Number,
    reductionFromBaseline: Number,
    reductionPercentage: Number,
    scope1: Number,
    scope2: Number,
    scope3: Number
  }],
  
  // Projections
  projections: [{
    year: Number,
    projectedEmissions: Number,
    targetEmissions: Number,
    gap: Number
  }]
});

const DecarbonizationPathwaySchema = new mongoose.Schema({
  // SBTi or custom targets
  targetType: { 
    type: String, 
    enum: ['SBTi_1.5C', 'SBTi_2C', 'custom', 'net_zero'],
    required: true 
  },
  
  baselineYear: { type: Number, required: true },
  targetYear: { type: Number, required: true },
  
  // Target emissions
  baselineEmissions: {
    scope1: Number,
    scope2: Number,
    scope3: Number,
    total: Number
  },
  
  targetEmissions: {
    scope1: Number,
    scope2: Number,
    scope3: Number,
    total: Number,
    reductionPercentage: Number
  },
  
  // Pathway milestones
  milestones: [{
    year: Number,
    targetEmissions: Number,
    actualEmissions: Number,
    onTrack: Boolean,
    notes: String
  }],
  
  // Decarbonization strategies
  strategies: [{
    strategyId: String,
    name: String,
    category: { 
      type: String, 
      enum: ['energy_efficiency', 'renewable_energy', 'process_optimization', 
             'carbon_capture', 'offsetting', 'supply_chain', 'other'] 
    },
    targetImpact: Number, // tCO2e reduction
    implementationYear: Number,
    cost: Number,
    status: { type: String, enum: ['planned', 'in_progress', 'implemented'] }
  }]
});

const TemplateSchema = new mongoose.Schema({
  templateType: { 
    type: String, 
    enum: ['flowchart', 'process', 'transport', 'reduction', 'decarbonization', 'full_sandbox'],
    required: true 
  },
  templateName: { type: String, required: true },
  templateVersion: { type: String, default: '1.0' },
  
  // Template content based on assessment level
  content: mongoose.Schema.Types.Mixed,
  
  // Assessment level this template is for
  assessmentLevel: [{
    type: String,
    enum: ['organization', 'process', 'reduction', 'decarbonization']
  }],
  
  // Preview data
  preview: {
    description: String,
    thumbnailUrl: String,
    features: [String],
    estimatedSetupTime: String
  },
  
  // Template metadata
  isDefault: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  usageCount: { type: Number, default: 0 },
  
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
  lastModified: { type: Date, default: Date.now }
});

const ApprovalWorkflowSchema = new mongoose.Schema({
  workflowStage: { 
    type: String, 
    enum: ['template_selection', 'data_setup', 'flowchart_review', 
           'calculation_review', 'final_approval', 'activated'],
    required: true 
  },
  
  status: { 
    type: String, 
    enum: ['pending', 'in_review', 'approved', 'rejected', 'changes_requested'],
    default: 'pending' 
  },
  
  // Approvers and their actions
  approvers: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userType: String,
    action: { type: String, enum: ['approve', 'reject', 'request_changes'] },
    comments: String,
    actionDate: Date
  }],
  
  // Required approvals
  requiredApprovals: [{
    role: { type: String, enum: ['consultant', 'consultant_admin', 'client_admin', 'super_admin'] },
    completed: { type: Boolean, default: false }
  }],
  
  // Current step details
  currentStep: {
    stepName: String,
    assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    dueDate: Date,
    notes: String
  },
  
  // Approval history
  history: [{
    stage: String,
    action: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedAt: Date,
    comments: String
  }],
  
  submittedAt: Date,
  approvedAt: Date,
  rejectedAt: Date
});

const ClientSandboxSchema = new mongoose.Schema({
  // Client reference
  clientId: { 
    type: String, 
    required: true,
    unique: true,
    index: true 
  },
  
  // Sandbox metadata
  sandboxName: { type: String, required: true },
  sandboxVersion: { type: String, default: '1.0' },
  
  // Assessment level determines what's shown
  assessmentLevel: [{
    type: String,
    enum: ['organization', 'process', 'reduction', 'decarbonization'],
    required: true
  }],
  
  // Sandbox status
  status: { 
    type: String, 
    enum: ['setup', 'configuring', 'testing', 'pending_approval', 'approved', 'active', 'archived'],
    default: 'setup' 
  },
  
  // Data flow visualization
  dataFlowSteps: [DataFlowStepSchema],
  
  // Emission monitoring
  emissionMonitoring: [EmissionMonitoringSchema],
  
  // Flowchart visualizations (organization, process, transport)
  flowcharts: [FlowchartVisualizationSchema],
  
  // Reduction tracking
  reductionData: ReductionVisualizationSchema,
  
  // Decarbonization pathway
  decarbonizationPathway: DecarbonizationPathwaySchema,
  
  // Templates used
  appliedTemplates: [TemplateSchema],
  
  // Approval workflow
  approvalWorkflow: ApprovalWorkflowSchema,
  
  // Configuration
  configuration: {
    dataCollectionFrequency: { type: String, enum: ['daily', 'weekly', 'monthly'], default: 'monthly' },
    calculationMethod: { type: String, enum: ['tier 1', 'tier 2', 'tier 3'], default: 'tier 1' },
    reportingPeriod: { type: String, enum: ['monthly', 'quarterly', 'yearly'], default: 'monthly' },
    autoCalculation: { type: Boolean, default: true },
    notificationsEnabled: { type: Boolean, default: true }
  },
  
  // Storage locations for files
  storageLocations: {
    reports: { type: String, default: '/mnt/user-data/outputs/sandboxes/reports/' },
    flowcharts: { type: String, default: '/mnt/user-data/outputs/sandboxes/flowcharts/' },
    calculations: { type: String, default: '/mnt/user-data/outputs/sandboxes/calculations/' },
    exports: { type: String, default: '/mnt/user-data/outputs/sandboxes/exports/' }
  },
  
  // Metadata
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  lastModifiedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
  lastModified: { 
    type: Date, 
    default: Date.now 
  },
  activatedAt: Date,
  activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Audit trail
  auditLog: [{
    action: String,
    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    performedAt: { type: Date, default: Date.now },
    details: mongoose.Schema.Types.Mixed
  }]
}, {
  timestamps: true
});

// Indexes for performance
ClientSandboxSchema.index({ clientId: 1, status: 1 });
ClientSandboxSchema.index({ 'assessmentLevel': 1 });
ClientSandboxSchema.index({ status: 1 });

// Methods
ClientSandboxSchema.methods.addAuditLog = function(action, userId, details) {
  this.auditLog.push({
    action,
    performedBy: userId,
    performedAt: new Date(),
    details
  });
};

ClientSandboxSchema.methods.updateDataFlow = async function(stepId, data) {
  const step = this.dataFlowSteps.find(s => s.stepId === stepId);
  if (step) {
    Object.assign(step, data);
    step.executedAt = new Date();
    this.lastModified = new Date();
  }
  return this.save();
};

ClientSandboxSchema.methods.updateEmissionMonitoring = async function(scopeIdentifier, emissions) {
  let monitoring = this.emissionMonitoring.find(m => m.scopeIdentifier === scopeIdentifier);
  
  if (!monitoring) {
    monitoring = {
      scopeIdentifier,
      scope: emissions.scope,
      nodeId: emissions.nodeId,
      nodeName: emissions.nodeName,
      currentEmissions: emissions,
      trends: [],
      alerts: []
    };
    this.emissionMonitoring.push(monitoring);
  } else {
    monitoring.currentEmissions = emissions;
    monitoring.trends.push({
      timestamp: new Date(),
      value: emissions.CO2e,
      period: 'current'
    });
    
    // Check thresholds and create alerts if needed
    if (monitoring.thresholds) {
      if (emissions.CO2e > monitoring.thresholds.critical) {
        monitoring.alerts.push({
          alertType: 'critical',
          message: `Emissions exceeded critical threshold: ${emissions.CO2e} > ${monitoring.thresholds.critical}`,
          triggeredAt: new Date(),
          resolved: false
        });
      } else if (emissions.CO2e > monitoring.thresholds.warning) {
        monitoring.alerts.push({
          alertType: 'warning',
          message: `Emissions exceeded warning threshold: ${emissions.CO2e} > ${monitoring.thresholds.warning}`,
          triggeredAt: new Date(),
          resolved: false
        });
      }
    }
  }
  
  monitoring.lastUpdated = new Date();
  this.lastModified = new Date();
  return this.save();
};

// Calculate overall sandbox completeness
ClientSandboxSchema.methods.calculateCompleteness = function() {
  let totalSteps = 0;
  let completedSteps = 0;
  
  // Check data flow steps
  if (this.dataFlowSteps.length > 0) {
    totalSteps += this.dataFlowSteps.length;
    completedSteps += this.dataFlowSteps.filter(s => s.status === 'completed').length;
  }
  
  // Check flowcharts
  if (this.assessmentLevel.includes('organization') || this.assessmentLevel.includes('process')) {
    totalSteps += 2; // organization and process flowcharts
    completedSteps += this.flowcharts.filter(f => f.status === 'approved').length;
  }
  
  // Check reduction data
  if (this.assessmentLevel.includes('reduction') && this.reductionData) {
    totalSteps += 1;
    if (this.reductionData.baseline && this.reductionData.current) {
      completedSteps += 1;
    }
  }
  
  // Check decarbonization pathway
  if (this.assessmentLevel.includes('decarbonization') && this.decarbonizationPathway) {
    totalSteps += 1;
    if (this.decarbonizationPathway.milestones && this.decarbonizationPathway.milestones.length > 0) {
      completedSteps += 1;
    }
  }
  
  return totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
};

module.exports = mongoose.model('ClientSandbox', ClientSandboxSchema);