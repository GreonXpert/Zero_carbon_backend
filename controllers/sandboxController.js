// controllers/sandboxController.js

const ClientSandbox = require('../models/ClientSandbox');
const Client = require('../models/Client');
const Flowchart = require('../models/Flowchart');
const ProcessFlowchart = require('../models/ProcessFlowchart');
const DataEntry = require('../models/DataEntry');
const EmissionSummary = require('../models/CalculationEmission/EmissionSummary');
const User = require('../models/User');
const Notification = require('../models/Notification');
const fs = require('fs').promises;
const path = require('path');

// =====================================================
// 1. CREATE SANDBOX AFTER CLIENT ACTIVATION
// =====================================================

/**
 * Create a new sandbox for an active client
 * Triggered automatically when client becomes active
 */
const createClientSandbox = async (req, res) => {
  try {
    const { clientId } = req.params;
    const userId = req.user.id;

    // 1. Validate client exists and is active
    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ 
        message: 'Client not found' 
      });
    }

    if (client.stage !== 'active') {
      return res.status(400).json({ 
        message: 'Sandbox can only be created for active clients',
        currentStage: client.stage 
      });
    }

    // 2. Check if sandbox already exists
    const existingSandbox = await ClientSandbox.findOne({ clientId });
    if (existingSandbox) {
      return res.status(400).json({ 
        message: 'Sandbox already exists for this client',
        sandboxId: existingSandbox._id 
      });
    }

    // 3. Get assessment level from client
    const assessmentLevel = client.submissionData?.assessmentLevel || [];
    if (assessmentLevel.length === 0) {
      return res.status(400).json({ 
        message: 'Client must have assessment level defined' 
      });
    }

    // 4. Initialize data flow steps based on assessment level
    const dataFlowSteps = initializeDataFlowSteps(assessmentLevel);

    // 5. Create storage directories
    const storageLocations = await createStorageDirectories(clientId);

    // 6. Create sandbox
    const sandbox = new ClientSandbox({
      clientId,
      sandboxName: `${client.leadInfo.companyName} - Sandbox`,
      assessmentLevel,
      status: 'setup',
      dataFlowSteps,
      storageLocations,
      createdBy: userId,
      approvalWorkflow: {
        workflowStage: 'template_selection',
        status: 'pending',
        requiredApprovals: [
          { role: 'consultant', completed: false },
          { role: 'consultant_admin', completed: false },
          { role: 'client_admin', completed: false }
        ],
        history: [{
          stage: 'template_selection',
          action: 'Sandbox created',
          performedBy: userId,
          performedAt: new Date(),
          comments: 'Initial sandbox setup'
        }]
      }
    });

    await sandbox.save();

    // 7. Add audit log
    sandbox.addAuditLog('sandbox_created', userId, {
      assessmentLevel,
      stage: 'setup'
    });
    await sandbox.save();

    // 8. Update client with sandbox reference
    client.sandboxId = sandbox._id;
    await client.save();

    // 9. Create notification for consultant
    if (client.workflowTracking?.assignedConsultantId) {
      await Notification.create({
        userId: client.workflowTracking.assignedConsultantId,
        type: 'sandbox_created',
        title: 'New Sandbox Created',
        message: `Sandbox has been created for ${client.leadInfo.companyName}`,
        relatedEntity: {
          entityType: 'sandbox',
          entityId: sandbox._id,
          clientId: client.clientId
        },
        priority: 'medium'
      });
    }

    res.status(201).json({
      message: 'Sandbox created successfully',
      sandbox: {
        id: sandbox._id,
        clientId: sandbox.clientId,
        status: sandbox.status,
        assessmentLevel: sandbox.assessmentLevel,
        completeness: sandbox.calculateCompleteness(),
        storageLocations: sandbox.storageLocations
      }
    });

  } catch (error) {
    console.error('Create sandbox error:', error);
    res.status(500).json({ 
      message: 'Failed to create sandbox', 
      error: error.message 
    });
  }
};

// =====================================================
// 2. GET SANDBOX DETAILS
// =====================================================

/**
 * Get comprehensive sandbox information
 */
const getSandboxDetails = async (req, res) => {
  try {
    const { clientId } = req.params;
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId })
      .populate('createdBy', 'userName email userType')
      .populate('lastModifiedBy', 'userName email')
      .populate('approvalWorkflow.approvers.userId', 'userName email userType');

    if (!sandbox) {
      return res.status(404).json({ 
        message: 'Sandbox not found' 
      });
    }

    // Check permissions
    const hasAccess = await checkSandboxAccess(userId, req.user.userType, clientId);
    if (!hasAccess) {
      return res.status(403).json({ 
        message: 'You do not have permission to view this sandbox' 
      });
    }

    // Calculate real-time metrics
    const metrics = await calculateSandboxMetrics(sandbox);

    res.status(200).json({
      sandbox: {
        id: sandbox._id,
        clientId: sandbox.clientId,
        sandboxName: sandbox.sandboxName,
        status: sandbox.status,
        assessmentLevel: sandbox.assessmentLevel,
        completeness: sandbox.calculateCompleteness(),
        
        // Data flow
        dataFlow: {
          steps: sandbox.dataFlowSteps,
          totalSteps: sandbox.dataFlowSteps.length,
          completedSteps: sandbox.dataFlowSteps.filter(s => s.status === 'completed').length
        },
        
        // Emission monitoring
        emissionMonitoring: {
          scopes: sandbox.emissionMonitoring,
          totalEmissions: metrics.totalEmissions,
          alerts: sandbox.emissionMonitoring.flatMap(m => m.alerts.filter(a => !a.resolved))
        },
        
        // Flowcharts
        flowcharts: sandbox.flowcharts.map(f => ({
          chartType: f.chartType,
          status: f.status,
          statistics: f.statistics,
          lastModified: f.lastModified
        })),
        
        // Reduction (if applicable)
        reduction: sandbox.assessmentLevel.includes('reduction') ? {
          baseline: sandbox.reductionData?.baseline,
          current: sandbox.reductionData?.current,
          initiatives: sandbox.reductionData?.initiatives || []
        } : null,
        
        // Decarbonization (if applicable)
        decarbonization: sandbox.assessmentLevel.includes('decarbonization') ? {
          targetType: sandbox.decarbonizationPathway?.targetType,
          baselineYear: sandbox.decarbonizationPathway?.baselineYear,
          targetYear: sandbox.decarbonizationPathway?.targetYear,
          milestones: sandbox.decarbonizationPathway?.milestones || []
        } : null,
        
        // Approval workflow
        approvalWorkflow: sandbox.approvalWorkflow,
        
        // Metadata
        createdBy: sandbox.createdBy,
        createdAt: sandbox.createdAt,
        lastModified: sandbox.lastModified,
        
        // Metrics
        metrics
      }
    });

  } catch (error) {
    console.error('Get sandbox details error:', error);
    res.status(500).json({ 
      message: 'Failed to retrieve sandbox details', 
      error: error.message 
    });
  }
};

// =====================================================
// 3. UPDATE DATA FLOW VISUALIZATION
// =====================================================

/**
 * Update data flow step with real-time calculation data
 */
const updateDataFlow = async (req, res) => {
  try {
    const { clientId, stepId } = req.params;
    const { inputSources, calculations, outputData, status } = req.body;
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId });
    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    const stepIndex = sandbox.dataFlowSteps.findIndex(s => s.stepId === stepId);
    if (stepIndex === -1) {
      return res.status(404).json({ message: 'Data flow step not found' });
    }

    const startTime = Date.now();

    // Update step data
    if (inputSources) sandbox.dataFlowSteps[stepIndex].inputSources = inputSources;
    if (calculations) sandbox.dataFlowSteps[stepIndex].calculations = calculations;
    if (outputData) sandbox.dataFlowSteps[stepIndex].outputData = outputData;
    if (status) sandbox.dataFlowSteps[stepIndex].status = status;
    
    sandbox.dataFlowSteps[stepIndex].executedAt = new Date();
    sandbox.dataFlowSteps[stepIndex].executionTime = Date.now() - startTime;

    sandbox.lastModified = new Date();
    sandbox.lastModifiedBy = userId;

    // Add audit log
    sandbox.addAuditLog('data_flow_updated', userId, {
      stepId,
      status,
      executionTime: sandbox.dataFlowSteps[stepIndex].executionTime
    });

    await sandbox.save();

    // Emit real-time update via socket if available
    if (global.io) {
      global.io.to(`client-${clientId}`).emit('sandbox_data_flow_updated', {
        clientId,
        stepId,
        status,
        completedSteps: sandbox.dataFlowSteps.filter(s => s.status === 'completed').length,
        totalSteps: sandbox.dataFlowSteps.length
      });
    }

    res.status(200).json({
      message: 'Data flow updated successfully',
      step: sandbox.dataFlowSteps[stepIndex],
      completeness: sandbox.calculateCompleteness()
    });

  } catch (error) {
    console.error('Update data flow error:', error);
    res.status(500).json({ 
      message: 'Failed to update data flow', 
      error: error.message 
    });
  }
};

// =====================================================
// 4. UPDATE EMISSION MONITORING
// =====================================================

/**
 * Update emission monitoring with real-time data
 */
const updateEmissionMonitoring = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { scopeIdentifier, emissions } = req.body;
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId });
    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    // Update emission monitoring
    await sandbox.updateEmissionMonitoring(scopeIdentifier, emissions);

    // Add audit log
    sandbox.addAuditLog('emission_monitoring_updated', userId, {
      scopeIdentifier,
      emissions: emissions.CO2e
    });

    await sandbox.save();

    // Emit real-time update
    if (global.io) {
      global.io.to(`client-${clientId}`).emit('sandbox_emissions_updated', {
        clientId,
        scopeIdentifier,
        currentEmissions: emissions.CO2e,
        timestamp: new Date()
      });
    }

    res.status(200).json({
      message: 'Emission monitoring updated successfully',
      monitoring: sandbox.emissionMonitoring.find(m => m.scopeIdentifier === scopeIdentifier)
    });

  } catch (error) {
    console.error('Update emission monitoring error:', error);
    res.status(500).json({ 
      message: 'Failed to update emission monitoring', 
      error: error.message 
    });
  }
};

// =====================================================
// 5. SYNC FLOWCHARTS TO SANDBOX
// =====================================================

/**
 * Sync organization and process flowcharts to sandbox
 */
const syncFlowchartsToSandbox = async (req, res) => {
  try {
    const { clientId } = req.params;
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId });
    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    const client = await Client.findOne({ clientId });
    
    // Sync organization flowchart (if assessment level includes organization)
    if (sandbox.assessmentLevel.includes('organization')) {
      const orgFlowchart = await Flowchart.findOne({ clientId, isActive: true });
      if (orgFlowchart) {
        await syncFlowchartVisualization(sandbox, orgFlowchart, 'organization');
      }
    }

    // Sync process flowchart (if assessment level includes process)
    if (sandbox.assessmentLevel.includes('process')) {
      const processFlowchart = await ProcessFlowchart.findOne({ clientId, isDeleted: false });
      if (processFlowchart) {
        await syncFlowchartVisualization(sandbox, processFlowchart, 'process');
      }
    }

    sandbox.lastModified = new Date();
    sandbox.lastModifiedBy = userId;

    sandbox.addAuditLog('flowcharts_synced', userId, {
      organizationSynced: sandbox.assessmentLevel.includes('organization'),
      processSynced: sandbox.assessmentLevel.includes('process')
    });

    await sandbox.save();

    res.status(200).json({
      message: 'Flowcharts synced successfully',
      flowcharts: sandbox.flowcharts
    });

  } catch (error) {
    console.error('Sync flowcharts error:', error);
    res.status(500).json({ 
      message: 'Failed to sync flowcharts', 
      error: error.message 
    });
  }
};

// =====================================================
// 6. TEMPLATE MANAGEMENT
// =====================================================

/**
 * Get available templates based on assessment level
 */
const getAvailableTemplates = async (req, res) => {
  try {
    const { clientId } = req.params;

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const assessmentLevel = client.submissionData?.assessmentLevel || [];

    // Get default templates for this assessment level
    const templates = getDefaultTemplates(assessmentLevel);

    res.status(200).json({
      templates,
      assessmentLevel
    });

  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ 
      message: 'Failed to retrieve templates', 
      error: error.message 
    });
  }
};

/**
 * Apply template to sandbox
 */
const applyTemplate = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { templateType, templateContent } = req.body;
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId });
    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    // Validate template type matches assessment level
    if (!validateTemplateForAssessment(templateType, sandbox.assessmentLevel)) {
      return res.status(400).json({ 
        message: 'Template type not valid for client assessment level',
        templateType,
        assessmentLevel: sandbox.assessmentLevel
      });
    }

    // Apply template
    const template = {
      templateType,
      templateName: templateContent.name || `${templateType} Template`,
      templateVersion: '1.0',
      content: templateContent,
      assessmentLevel: sandbox.assessmentLevel,
      isDefault: false,
      isActive: true,
      usageCount: 1,
      createdBy: userId,
      createdAt: new Date()
    };

    sandbox.appliedTemplates.push(template);
    
    // Update approval workflow stage
    sandbox.approvalWorkflow.workflowStage = 'data_setup';
    sandbox.approvalWorkflow.history.push({
      stage: 'template_selection',
      action: 'Template applied',
      performedBy: userId,
      performedAt: new Date(),
      comments: `Applied ${templateType} template`
    });

    sandbox.lastModified = new Date();
    sandbox.lastModifiedBy = userId;

    sandbox.addAuditLog('template_applied', userId, {
      templateType,
      templateName: template.templateName
    });

    await sandbox.save();

    res.status(200).json({
      message: 'Template applied successfully',
      template,
      approvalWorkflow: sandbox.approvalWorkflow
    });

  } catch (error) {
    console.error('Apply template error:', error);
    res.status(500).json({ 
      message: 'Failed to apply template', 
      error: error.message 
    });
  }
};

// =====================================================
// 7. APPROVAL WORKFLOW
// =====================================================

/**
 * Submit sandbox for approval
 */
const submitForApproval = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { comments } = req.body;
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId });
    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    // Validate sandbox is ready for approval
    const completeness = sandbox.calculateCompleteness();
    if (completeness < 80) {
      return res.status(400).json({ 
        message: 'Sandbox must be at least 80% complete before submission',
        currentCompleteness: completeness
      });
    }

    // Update approval workflow
    sandbox.status = 'pending_approval';
    sandbox.approvalWorkflow.status = 'in_review';
    sandbox.approvalWorkflow.submittedAt = new Date();
    sandbox.approvalWorkflow.history.push({
      stage: sandbox.approvalWorkflow.workflowStage,
      action: 'Submitted for approval',
      performedBy: userId,
      performedAt: new Date(),
      comments: comments || 'Sandbox submitted for review'
    });

    sandbox.lastModified = new Date();
    sandbox.lastModifiedBy = userId;

    sandbox.addAuditLog('submitted_for_approval', userId, {
      completeness,
      comments
    });

    await sandbox.save();

    // Create notifications for approvers
    await createApprovalNotifications(sandbox, userId);

    // Emit real-time notification
    if (global.io) {
      global.io.to(`client-${clientId}`).emit('sandbox_submitted_for_approval', {
        clientId,
        submittedBy: userId,
        timestamp: new Date()
      });
    }

    res.status(200).json({
      message: 'Sandbox submitted for approval successfully',
      status: sandbox.status,
      approvalWorkflow: sandbox.approvalWorkflow
    });

  } catch (error) {
    console.error('Submit for approval error:', error);
    res.status(500).json({ 
      message: 'Failed to submit for approval', 
      error: error.message 
    });
  }
};

/**
 * Approve or reject sandbox
 */
const processApproval = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { action, comments } = req.body; // action: 'approve' | 'reject' | 'request_changes'
    const userId = req.user.id;
    const userType = req.user.userType;

    const sandbox = await ClientSandbox.findOne({ clientId });
    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    if (sandbox.status !== 'pending_approval') {
      return res.status(400).json({ 
        message: 'Sandbox is not in pending approval status',
        currentStatus: sandbox.status
      });
    }

    // Check if user has approval rights
    const hasApprovalRights = ['consultant_admin', 'client_admin', 'super_admin'].includes(userType);
    if (!hasApprovalRights) {
      return res.status(403).json({ 
        message: 'You do not have approval rights' 
      });
    }

    // Record approval action
    const approvalRecord = {
      userId,
      userType,
      action,
      comments: comments || '',
      actionDate: new Date()
    };

    sandbox.approvalWorkflow.approvers.push(approvalRecord);

    // Update required approvals
    const requiredApprovalIndex = sandbox.approvalWorkflow.requiredApprovals.findIndex(
      ra => ra.role === userType || (userType === 'super_admin' && !ra.completed)
    );
    
    if (requiredApprovalIndex !== -1 && action === 'approve') {
      sandbox.approvalWorkflow.requiredApprovals[requiredApprovalIndex].completed = true;
    }

    // Check if all required approvals are complete
    const allApproved = sandbox.approvalWorkflow.requiredApprovals.every(ra => ra.completed);

    if (action === 'approve' && allApproved) {
      sandbox.status = 'approved';
      sandbox.approvalWorkflow.status = 'approved';
      sandbox.approvalWorkflow.approvedAt = new Date();
      sandbox.approvalWorkflow.workflowStage = 'final_approval';
    } else if (action === 'reject') {
      sandbox.status = 'setup';
      sandbox.approvalWorkflow.status = 'rejected';
      sandbox.approvalWorkflow.rejectedAt = new Date();
    } else if (action === 'request_changes') {
      sandbox.status = 'configuring';
      sandbox.approvalWorkflow.status = 'changes_requested';
    }

    // Add to history
    sandbox.approvalWorkflow.history.push({
      stage: sandbox.approvalWorkflow.workflowStage,
      action: action,
      performedBy: userId,
      performedAt: new Date(),
      comments: comments || ''
    });

    sandbox.lastModified = new Date();
    sandbox.lastModifiedBy = userId;

    sandbox.addAuditLog('approval_processed', userId, {
      action,
      userType,
      allApproved
    });

    await sandbox.save();

    // Send notifications
    await notifyApprovalAction(sandbox, userId, action);

    res.status(200).json({
      message: `Sandbox ${action}d successfully`,
      status: sandbox.status,
      approvalWorkflow: sandbox.approvalWorkflow
    });

  } catch (error) {
    console.error('Process approval error:', error);
    res.status(500).json({ 
      message: 'Failed to process approval', 
      error: error.message 
    });
  }
};

/**
 * Activate approved sandbox
 */
const activateSandbox = async (req, res) => {
  try {
    const { clientId } = req.params;
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId });
    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    if (sandbox.status !== 'approved') {
      return res.status(400).json({ 
        message: 'Sandbox must be approved before activation',
        currentStatus: sandbox.status
      });
    }

    // Activate sandbox
    sandbox.status = 'active';
    sandbox.activatedAt = new Date();
    sandbox.activatedBy = userId;
    sandbox.approvalWorkflow.workflowStage = 'activated';
    
    sandbox.approvalWorkflow.history.push({
      stage: 'activation',
      action: 'Sandbox activated',
      performedBy: userId,
      performedAt: new Date(),
      comments: 'Sandbox is now live and operational'
    });

    sandbox.lastModified = new Date();
    sandbox.lastModifiedBy = userId;

    sandbox.addAuditLog('sandbox_activated', userId, {
      activatedAt: new Date()
    });

    await sandbox.save();

    // Update client status
    const client = await Client.findOne({ clientId });
    if (client) {
      client.sandboxActive = true;
      await client.save();
    }

    // Send notifications
    await notifySandboxActivation(sandbox, userId);

    res.status(200).json({
      message: 'Sandbox activated successfully',
      sandbox: {
        id: sandbox._id,
        clientId: sandbox.clientId,
        status: sandbox.status,
        activatedAt: sandbox.activatedAt
      }
    });

  } catch (error) {
    console.error('Activate sandbox error:', error);
    res.status(500).json({ 
      message: 'Failed to activate sandbox', 
      error: error.message 
    });
  }
};

// =====================================================
// 8. EXPORT SANDBOX DATA
// =====================================================

/**
 * Export sandbox data to file
 */
const exportSandboxData = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { format } = req.query; // 'json' | 'pdf' | 'excel'
    const userId = req.user.id;

    const sandbox = await ClientSandbox.findOne({ clientId })
      .populate('createdBy', 'userName email')
      .populate('lastModifiedBy', 'userName email');

    if (!sandbox) {
      return res.status(404).json({ message: 'Sandbox not found' });
    }

    // Generate export based on format
    let exportPath;
    let exportData;

    switch (format) {
      case 'json':
        exportData = sandbox.toJSON();
        exportPath = path.join(sandbox.storageLocations.exports, `sandbox_${clientId}_${Date.now()}.json`);
        await fs.writeFile(exportPath, JSON.stringify(exportData, null, 2));
        break;

      case 'pdf':
        // Generate PDF report (implement your PDF generation logic)
        exportPath = await generateSandboxPDF(sandbox);
        break;

      case 'excel':
        // Generate Excel report (implement your Excel generation logic)
        exportPath = await generateSandboxExcel(sandbox);
        break;

      default:
        return res.status(400).json({ message: 'Invalid export format' });
    }

    sandbox.addAuditLog('sandbox_exported', userId, {
      format,
      exportPath
    });
    await sandbox.save();

    res.status(200).json({
      message: 'Sandbox data exported successfully',
      downloadUrl: `/api/sandbox/download/${clientId}?file=${path.basename(exportPath)}`
    });

  } catch (error) {
    console.error('Export sandbox error:', error);
    res.status(500).json({ 
      message: 'Failed to export sandbox data', 
      error: error.message 
    });
  }
};

// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * Initialize data flow steps based on assessment level
 */
function initializeDataFlowSteps(assessmentLevel) {
  const steps = [
    {
      stepId: 'step_1',
      stepName: 'Data Collection',
      stepType: 'data_collection',
      inputSources: [],
      calculations: [],
      outputData: {},
      status: 'pending',
      order: 1
    },
    {
      stepId: 'step_2',
      stepName: 'Emission Calculation',
      stepType: 'calculation',
      inputSources: [],
      calculations: [],
      outputData: {},
      status: 'pending',
      order: 2
    },
    {
      stepId: 'step_3',
      stepName: 'Data Validation',
      stepType: 'validation',
      inputSources: [],
      calculations: [],
      outputData: {},
      status: 'pending',
      order: 3
    },
    {
      stepId: 'step_4',
      stepName: 'Aggregation',
      stepType: 'aggregation',
      inputSources: [],
      calculations: [],
      outputData: {},
      status: 'pending',
      order: 4
    }
  ];

  // Add reduction step if applicable
  if (assessmentLevel.includes('reduction')) {
    steps.push({
      stepId: 'step_5',
      stepName: 'Reduction Calculation',
      stepType: 'calculation',
      inputSources: [],
      calculations: [],
      outputData: {},
      status: 'pending',
      order: 5
    });
  }

  // Add reporting step
  steps.push({
    stepId: `step_${steps.length + 1}`,
    stepName: 'Report Generation',
    stepType: 'reporting',
    inputSources: [],
    calculations: [],
    outputData: {},
    status: 'pending',
    order: steps.length + 1
  });

  return steps;
}

/**
 * Create storage directories for sandbox files
 */
async function createStorageDirectories(clientId) {
  const baseDir = '/mnt/user-data/outputs/sandboxes';
  const clientDir = path.join(baseDir, clientId);

  const directories = {
    reports: path.join(clientDir, 'reports'),
    flowcharts: path.join(clientDir, 'flowcharts'),
    calculations: path.join(clientDir, 'calculations'),
    exports: path.join(clientDir, 'exports')
  };

  // Create directories
  for (const dir of Object.values(directories)) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create directory ${dir}:`, error);
    }
  }

  return directories;
}

/**
 * Check if user has access to sandbox
 */
async function checkSandboxAccess(userId, userType, clientId) {
  if (userType === 'super_admin') return true;
  if (userType === 'consultant_admin') return true;

  if (userType === 'consultant') {
    const client = await Client.findOne({ clientId });
    return client?.workflowTracking?.assignedConsultantId?.toString() === userId;
  }

  if (['client_admin', 'client_employee_head', 'employee'].includes(userType)) {
    const user = await User.findById(userId);
    return user?.clientId === clientId;
  }

  return false;
}

/**
 * Calculate sandbox metrics
 */
async function calculateSandboxMetrics(sandbox) {
  const totalEmissions = sandbox.emissionMonitoring.reduce((sum, m) => 
    sum + (m.currentEmissions?.CO2e || 0), 0
  );

  const activeAlerts = sandbox.emissionMonitoring.flatMap(m => 
    m.alerts.filter(a => !a.resolved)
  ).length;

  const dataFlowProgress = sandbox.dataFlowSteps.length > 0
    ? (sandbox.dataFlowSteps.filter(s => s.status === 'completed').length / sandbox.dataFlowSteps.length) * 100
    : 0;

  return {
    totalEmissions,
    activeAlerts,
    dataFlowProgress: Math.round(dataFlowProgress),
    completeness: sandbox.calculateCompleteness(),
    lastCalculationTime: sandbox.dataFlowSteps
      .filter(s => s.executedAt)
      .reduce((latest, s) => s.executedAt > latest ? s.executedAt : latest, new Date(0))
  };
}

/**
 * Sync flowchart to sandbox visualization
 */
async function syncFlowchartVisualization(sandbox, flowchart, chartType) {
  // Remove existing chart of this type
  sandbox.flowcharts = sandbox.flowcharts.filter(f => f.chartType !== chartType);

  // Calculate emissions for each node
  const nodesWithEmissions = await Promise.all(
    flowchart.nodes.map(async (node) => {
      let totalEmissions = 0;
      
      // Calculate emissions from scope details
      if (node.details?.scopeDetails) {
        for (const scope of node.details.scopeDetails) {
          const entries = await DataEntry.find({
            clientId: sandbox.clientId,
            nodeId: node.id,
            scopeIdentifier: scope.scopeIdentifier
          }).sort({ timestamp: -1 }).limit(1);

          if (entries.length > 0 && entries[0].calculatedEmissions) {
            const emissions = entries[0].calculatedEmissions.cumulative;
            totalEmissions += emissions.get('CO2e') || 0;
          }
        }
      }

      return {
        id: node.id,
        label: node.label,
        type: node.details?.nodeType || 'default',
        position: node.position,
        data: node.details,
        emissions: {
          current: totalEmissions,
          target: 0, // TODO: Get from targets
          percentage: 0
        }
      };
    })
  );

  // Calculate total emissions and statistics
  const totalEmissions = nodesWithEmissions.reduce((sum, n) => sum + n.emissions.current, 0);
  const totalScopes = flowchart.nodes.reduce((sum, n) => 
    sum + (n.details?.scopeDetails?.length || 0), 0
  );

  // Add flowchart visualization
  sandbox.flowcharts.push({
    chartType,
    flowchartId: flowchart._id,
    chartName: chartType === 'organization' ? 'Organization Flowchart' : 'Process Flowchart',
    nodes: nodesWithEmissions,
    edges: flowchart.edges,
    statistics: {
      totalNodes: flowchart.nodes.length,
      totalScopes,
      totalEmissions,
      dataCompleteness: 0 // TODO: Calculate data completeness
    },
    status: 'approved',
    createdAt: flowchart.createdAt,
    lastModified: new Date()
  });
}

/**
 * Get default templates for assessment level
 */
function getDefaultTemplates(assessmentLevel) {
  const templates = [];

  if (assessmentLevel.includes('organization')) {
    templates.push({
      templateType: 'flowchart',
      templateName: 'Standard Organization Flowchart',
      description: 'Complete organizational structure with all emission scopes',
      features: ['Facility mapping', 'Department tracking', 'Scope 1, 2, 3 emissions', 'Data input points'],
      estimatedSetupTime: '2-3 hours',
      preview: {
        nodes: 5,
        scopes: 15,
        dataPoints: 30
      }
    });
  }

  if (assessmentLevel.includes('process')) {
    templates.push({
      templateType: 'process',
      templateName: 'Manufacturing Process Template',
      description: 'Detailed process flow with emission calculations',
      features: ['Process mapping', 'Material flow', 'Energy consumption', 'Waste tracking'],
      estimatedSetupTime: '3-4 hours',
      preview: {
        processes: 10,
        materials: 20,
        energyPoints: 15
      }
    });
  }

  if (assessmentLevel.includes('reduction')) {
    templates.push({
      templateType: 'reduction',
      templateName: 'Emission Reduction Tracker',
      description: 'Track reduction initiatives and measure impact',
      features: ['Baseline setting', 'Initiative tracking', 'Impact measurement', 'Progress reporting'],
      estimatedSetupTime: '1-2 hours',
      preview: {
        initiatives: 5,
        targets: 3,
        metrics: 10
      }
    });
  }

  if (assessmentLevel.includes('decarbonization')) {
    templates.push({
      templateType: 'decarbonization',
      templateName: 'SBTi-Aligned Decarbonization Pathway',
      description: 'Science-based targets and decarbonization strategy',
      features: ['SBTi alignment', 'Trajectory planning', 'Milestone tracking', 'Strategy mapping'],
      estimatedSetupTime: '2-3 hours',
      preview: {
        milestones: 10,
        strategies: 8,
        years: 20
      }
    });
  }

  return templates;
}

/**
 * Validate template for assessment level
 */
function validateTemplateForAssessment(templateType, assessmentLevel) {
  const validationMap = {
    'flowchart': ['organization'],
    'process': ['process'],
    'reduction': ['reduction'],
    'decarbonization': ['decarbonization']
  };

  const requiredLevels = validationMap[templateType] || [];
  return requiredLevels.some(level => assessmentLevel.includes(level));
}

/**
 * Create approval notifications
 */
async function createApprovalNotifications(sandbox, submittedBy) {
  const client = await Client.findOne({ clientId: sandbox.clientId });
  
  // Notify consultant admin
  const consultantAdmins = await User.find({ userType: 'consultant_admin' });
  for (const admin of consultantAdmins) {
    await Notification.create({
      userId: admin._id,
      type: 'sandbox_approval_required',
      title: 'Sandbox Approval Required',
      message: `Sandbox for ${client.leadInfo.companyName} is ready for review`,
      relatedEntity: {
        entityType: 'sandbox',
        entityId: sandbox._id,
        clientId: sandbox.clientId
      },
      priority: 'high'
    });
  }

  // Notify client admin
  const clientAdmins = await User.find({ 
    userType: 'client_admin', 
    clientId: sandbox.clientId 
  });
  for (const admin of clientAdmins) {
    await Notification.create({
      userId: admin._id,
      type: 'sandbox_approval_required',
      title: 'Sandbox Approval Required',
      message: 'Your sandbox is ready for final approval',
      relatedEntity: {
        entityType: 'sandbox',
        entityId: sandbox._id,
        clientId: sandbox.clientId
      },
      priority: 'high'
    });
  }
}

/**
 * Notify approval action
 */
async function notifyApprovalAction(sandbox, userId, action) {
  const client = await Client.findOne({ clientId: sandbox.clientId });
  const user = await User.findById(userId);

  // Notify sandbox creator
  await Notification.create({
    userId: sandbox.createdBy,
    type: `sandbox_${action}d`,
    title: `Sandbox ${action}d`,
    message: `Your sandbox for ${client.leadInfo.companyName} has been ${action}d by ${user.userName}`,
    relatedEntity: {
      entityType: 'sandbox',
      entityId: sandbox._id,
      clientId: sandbox.clientId
    },
    priority: action === 'approve' ? 'medium' : 'high'
  });
}

/**
 * Notify sandbox activation
 */
async function notifySandboxActivation(sandbox, activatedBy) {
  const client = await Client.findOne({ clientId: sandbox.clientId });
  
  // Notify all users associated with this client
  const users = await User.find({ 
    $or: [
      { clientId: sandbox.clientId },
      { _id: client.workflowTracking?.assignedConsultantId }
    ]
  });

  for (const user of users) {
    await Notification.create({
      userId: user._id,
      type: 'sandbox_activated',
      title: 'Sandbox Activated',
      message: `Sandbox for ${client.leadInfo.companyName} is now active and operational`,
      relatedEntity: {
        entityType: 'sandbox',
        entityId: sandbox._id,
        clientId: sandbox.clientId
      },
      priority: 'high'
    });
  }
}

/**
 * Generate PDF report (placeholder - implement your PDF logic)
 */
async function generateSandboxPDF(sandbox) {
  // TODO: Implement PDF generation using your preferred library
  const exportPath = path.join(
    sandbox.storageLocations.exports, 
    `sandbox_report_${sandbox.clientId}_${Date.now()}.pdf`
  );
  
  // Your PDF generation logic here
  
  return exportPath;
}

/**
 * Generate Excel report (placeholder - implement your Excel logic)
 */
async function generateSandboxExcel(sandbox) {
  // TODO: Implement Excel generation using your preferred library
  const exportPath = path.join(
    sandbox.storageLocations.exports, 
    `sandbox_data_${sandbox.clientId}_${Date.now()}.xlsx`
  );
  
  // Your Excel generation logic here
  
  return exportPath;
}

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  createClientSandbox,
  getSandboxDetails,
  updateDataFlow,
  updateEmissionMonitoring,
  syncFlowchartsToSandbox,
  getAvailableTemplates,
  applyTemplate,
  submitForApproval,
  processApproval,
  activateSandbox,
  exportSandboxData
};