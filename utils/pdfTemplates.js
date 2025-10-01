// utils/pdfTemplates.js
const moment = require('moment');

const baseCSS = `
  <style>
    @page { size: A4; margin: 18mm; }
    body { font-family: -apple-system, BlinkMacSystemFont,'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', Arial, sans-serif; color:#1f2937; }
    .brand { color:#0ea5e9; font-weight:800; letter-spacing:.5px }
    .card { border:1px solid #e5e7eb; border-radius:12px; padding:16px; margin:12px 0; }
    .title { font-size:24px; font-weight:800; margin:0 0 8px 0; }
    .sub { color:#6b7280; margin:0 0 18px 0; }
    .row { display:flex; gap:12px; margin:8px 0; }
    .col { flex:1; }
    .label { font-size:12px; color:#6b7280; }
    .value { font-size:14px; font-weight:600; }
    table { width:100%; border-collapse: collapse; margin-top:10px;}
    th, td { border:1px solid #e5e7eb; padding:8px; text-align:left; font-size:13px;}
    th { background:#f8fafc;}
    .badge { display:inline-block; background:#eef2ff; color:#4f46e5; padding:4px 10px; border-radius:9999px; font-size:11px; font-weight:700;}
    .muted { color:#6b7280; }
    .hr { height:1px; background:#e5e7eb; margin:16px 0; }
  </style>
`;

function safe(v, fallback = '—') {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string' && v.trim() === '') return fallback;
  return v;
}

function renderHeader(client, heading, subtitle) {
  return `
    <div>
      <div class="brand">ZeroCarbon</div>
      <h1 class="title">${heading}</h1>
      <p class="sub">${subtitle}</p>
      <div class="row">
        <div class="col">
          <div class="label">Client ID</div>
          <div class="value">${client.clientId}</div>
        </div>
        <div class="col">
          <div class="label">Company</div>
          <div class="value">${safe(client?.leadInfo?.companyName)}</div>
        </div>
        <div class="col">
          <div class="label">Contact</div>
          <div class="value">${safe(client?.leadInfo?.contactPersonName)}</div>
        </div>
      </div>
      <div class="hr"></div>
    </div>
  `;
}

/** CLIENT DATA PDF */
function renderClientDataHTML(client) {
  const data = client?.submissionData || {};
  const primary = data?.companyInfo?.primaryContactPerson || {};
  const alternate = data?.companyInfo?.alternateContactPerson || {};
  const org = data?.organizationalOverview || {};
  const emissions = data?.emissionsProfile || {};
  const ghgData = data?.ghgDataManagement || {};
  const additional = data?.additionalNotes || {};
  const docs = data?.supportingDocuments || [];
  const submittedAt = additional?.completionDate || data?.submittedAt;

  return `
    <!doctype html><html><head><meta charset="utf-8" />${baseCSS}</head>
    <body>
      ${renderHeader(
        client,
        'Client Data Snapshot',
        `Generated on ${moment().format('DD MMM YYYY, HH:mm')} • Stage: ${client.stage} • Status: ${client.status} • Assessment Level: ${safe(data.assessmentLevel).toUpperCase()}`
      )}

      <div class="card">
        <div class="badge">Company Information</div>
        <div class="row">
          <div class="col">
            <div class="label">Company Name</div>
            <div class="value">${safe(data?.companyInfo?.companyName)}</div>
          </div>
          <div class="col">
            <div class="label">Industry Sector</div>
            <div class="value">${safe(org.industrySector)}</div>
          </div>
          <div class="col">
            <div class="label">Accounting Year</div>
            <div class="value">${safe(org.accountingYear)}</div>
          </div>
        </div>
        <div class="row">
          <div class="col" style="flex: 2;">
            <div class="label">Company Address</div>
            <div class="value" style="font-weight:500; line-height:1.4;">${safe(data?.companyInfo?.companyAddress)}</div>
          </div>
          <div class="col">
            <div class="label">Total Employees</div>
            <div class="value">${safe(org.totalEmployees, 0)}</div>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <div class="label">Company Description</div>
            <div class="value" style="font-weight:500; line-height:1.4;">${safe(org.companyDescription)}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Contact Information</div>
        <div class="row">
          <div class="col">
            <div class="label">Primary Contact</div>
            <div class="value">${safe(primary.name)}</div>
            <div class="muted">${safe(primary.designation)}</div>
            <div class="muted">📧 ${safe(primary.email)}</div>
            <div class="muted">📞 ${safe(primary.phoneNumber)}</div>
          </div>
          <div class="col">
            <div class="label">Alternate Contact</div>
            <div class="value">${safe(alternate.name)}</div>
            <div class="muted">${safe(alternate.designation)}</div>
            <div class="muted">📧 ${safe(alternate.email)}</div>
            <div class="muted">📞 ${safe(alternate.phoneNumber)}</div>
          </div>
          <div class="col">
            <div class="label">Submission Details</div>
            <div class="value">Completed by: ${safe(additional.completedBy)}</div>
            <div class="muted">Date: ${submittedAt ? moment(submittedAt).format('DD MMM YYYY, HH:mm') : '—'}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Operational Sites (${safe(org.numberOfOperationalSites, 0)} locations)</div>
        <table>
          <thead>
            <tr>
              <th>Site Name</th>
              <th>Location</th>
              <th>Operations</th>
              <th>Production Capacity</th>
              <th>Employee Count</th>
            </tr>
          </thead>
          <tbody>
            ${org.sitesDetails?.map((site, index) => {
              const employeeInfo = org.employeesByFacility?.find(emp => 
                emp.facilityName === site.siteName
              ) || {};
              return `
                <tr>
                  <td><strong>${safe(site.siteName)}</strong></td>
                  <td>${safe(site.location)}</td>
                  <td>${safe(site.operation)}</td>
                  <td>${safe(site.productionCapacity)}</td>
                  <td>${safe(employeeInfo.employeeCount, 0)}</td>
                </tr>
              `;
            }).join('') || '<tr><td colspan="5" class="muted">No site details provided</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="badge">Scope 1 Emissions - Direct Emissions</div>
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Included</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Stationary Combustion</strong></td>
              <td>${emissions.scope1?.stationaryCombustion?.included ? '✅ Yes' : '❌ No'}</td>
              <td class="muted">
                ${emissions.scope1?.stationaryCombustion?.included ? `
                  Fuel: ${safe(emissions.scope1.stationaryCombustion.details?.fuelType)}<br>
                  Quantity: ${safe(emissions.scope1.stationaryCombustion.details?.quantityUsed)}<br>
                  Equipment: ${safe(emissions.scope1.stationaryCombustion.details?.equipmentType)}<br>
                  Hours: ${safe(emissions.scope1.stationaryCombustion.details?.operationalHours)}
                ` : 'Not included'}
              </td>
            </tr>
            <tr>
              <td><strong>Mobile Combustion</strong></td>
              <td>${emissions.scope1?.mobileCombustion?.included ? '✅ Yes' : '❌ No'}</td>
              <td class="muted">
                ${emissions.scope1?.mobileCombustion?.included ? `
                  Vehicle: ${safe(emissions.scope1.mobileCombustion.details?.vehicleType)}<br>
                  Fuel: ${safe(emissions.scope1.mobileCombustion.details?.fuelType)}<br>
                  Distance: ${safe(emissions.scope1.mobileCombustion.details?.distanceTraveled)}<br>
                  Consumption: ${safe(emissions.scope1.mobileCombustion.details?.fuelConsumed)}
                ` : 'Not included'}
              </td>
            </tr>
            <tr>
              <td><strong>Process Emissions</strong></td>
              <td>${emissions.scope1?.processEmissions?.included ? '✅ Yes' : '❌ No'}</td>
              <td class="muted">${emissions.scope1?.processEmissions?.included ? 'Details provided' : 'Not included'}</td>
            </tr>
            <tr>
              <td><strong>Fugitive Emissions</strong></td>
              <td>${emissions.scope1?.fugitiveEmissions?.included ? '✅ Yes' : '❌ No'}</td>
              <td class="muted">${emissions.scope1?.fugitiveEmissions?.included ? 'Details provided' : 'Not included'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="badge">Scope 2 Emissions - Indirect Energy Emissions</div>
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Included</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Purchased Electricity</strong></td>
              <td>${emissions.scope2?.purchasedElectricity?.included ? '✅ Yes' : '❌ No'}</td>
              <td class="muted">
                ${emissions.scope2?.purchasedElectricity?.included ? `
                  Monthly: ${safe(emissions.scope2.purchasedElectricity.details?.monthlyConsumption)}<br>
                  Annual: ${safe(emissions.scope2.purchasedElectricity.details?.annualConsumption)}<br>
                  Supplier: ${safe(emissions.scope2.purchasedElectricity.details?.supplierDetails)}<br>
                  Unit: ${safe(emissions.scope2.purchasedElectricity.details?.unit)}
                ` : 'Not included'}
              </td>
            </tr>
            <tr>
              <td><strong>Purchased Steam/Heating</strong></td>
              <td>${emissions.scope2?.purchasedSteamHeating?.included ? '✅ Yes' : '❌ No'}</td>
              <td class="muted">${emissions.scope2?.purchasedSteamHeating?.included ? 'Details provided' : 'Not included'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="badge">Scope 3 Emissions - Other Indirect Emissions</div>
        <div class="row">
          <div class="col">
            <div class="label">Include Scope 3</div>
            <div class="value">${emissions.scope3?.includeScope3 ? '✅ Yes' : '❌ No'}</div>
          </div>
          <div class="col" style="flex: 2;">
            <div class="label">Other Indirect Sources</div>
            <div class="value" style="font-weight:500;">${safe(emissions.scope3?.otherIndirectSources)}</div>
          </div>
        </div>
        ${emissions.scope3?.includeScope3 ? `
          <table style="margin-top: 12px;">
            <thead>
              <tr>
                <th>Category</th>
                <th>Included</th>
                <th>Category</th>
                <th>Included</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Business Travel</td>
                <td>${emissions.scope3?.categories?.businessTravel ? '✅' : '❌'}</td>
                <td>Employee Commuting</td>
                <td>${emissions.scope3?.categories?.employeeCommuting ? '✅' : '❌'}</td>
              </tr>
              <tr>
                <td>Waste Generated</td>
                <td>${emissions.scope3?.categories?.wasteGenerated ? '✅' : '❌'}</td>
                <td>Upstream Transportation</td>
                <td>${emissions.scope3?.categories?.upstreamTransportation ? '✅' : '❌'}</td>
              </tr>
              <tr>
                <td>Downstream Transportation</td>
                <td>${emissions.scope3?.categories?.downstreamTransportation ? '✅' : '❌'}</td>
                <td>Purchased Goods & Services</td>
                <td>${emissions.scope3?.categories?.purchasedGoodsAndServices ? '✅' : '❌'}</td>
              </tr>
              <tr>
                <td>Capital Goods</td>
                <td>${emissions.scope3?.categories?.capitalGoods ? '✅' : '❌'}</td>
                <td>Fuel & Energy Related</td>
                <td>${emissions.scope3?.categories?.fuelAndEnergyRelated ? '✅' : '❌'}</td>
              </tr>
              <tr>
                <td>Upstream Leased Assets</td>
                <td>${emissions.scope3?.categories?.upstreamLeasedAssets ? '✅' : '❌'}</td>
                <td>Downstream Leased Assets</td>
                <td>${emissions.scope3?.categories?.downstreamLeasedAssets ? '✅' : '❌'}</td>
              </tr>
              <tr>
                <td>Processing of Sold Products</td>
                <td>${emissions.scope3?.categories?.processingOfSoldProducts ? '✅' : '❌'}</td>
                <td>Use of Sold Products</td>
                <td>${emissions.scope3?.categories?.useOfSoldProducts ? '✅' : '❌'}</td>
              </tr>
              <tr>
                <td>End-of-Life Treatment</td>
                <td>${emissions.scope3?.categories?.endOfLifeTreatment ? '✅' : '❌'}</td>
                <td>Franchises</td>
                <td>${emissions.scope3?.categories?.franchises ? '✅' : '❌'}</td>
              </tr>
              <tr>
                <td>Investments</td>
                <td>${emissions.scope3?.categories?.investments ? '✅' : '❌'}</td>
                <td></td>
                <td></td>
              </tr>
            </tbody>
          </table>
        ` : ''}
      </div>

      <div class="card">
        <div class="badge">GHG Data Management</div>
        <div class="row">
          <div class="col">
            <div class="label">Previous Carbon Accounting</div>
            <div class="value">${ghgData.previousCarbonAccounting?.conducted ? '✅ Yes' : '❌ No'}</div>
            ${ghgData.previousCarbonAccounting?.conducted ? `
              <div class="muted" style="margin-top: 6px;">
                Details: ${safe(ghgData.previousCarbonAccounting.details)}<br>
                Methodologies: ${safe(ghgData.previousCarbonAccounting.methodologies)}
              </div>
            ` : ''}
          </div>
          <div class="col">
            <div class="label">ISO Compliance</div>
            <div class="value">${ghgData.isoCompliance?.hasEMSorQMS ? '✅ Has EMS/QMS' : '❌ No EMS/QMS'}</div>
            <div class="value">${ghgData.isoCompliance?.containsGHGProcedures ? '✅ GHG Procedures' : '❌ No GHG Procedures'}</div>
            <div class="muted" style="margin-top: 6px;">
              ${safe(ghgData.isoCompliance?.certificationDetails)}
            </div>
          </div>
        </div>
        <div class="row" style="margin-top: 12px;">
          <div class="col">
            <div class="label">Available Data Types</div>
            <div class="value">
              ${ghgData.dataTypesAvailable?.energyUsage ? '✅ Energy Usage ' : ''}
              ${ghgData.dataTypesAvailable?.fuelConsumption ? '✅ Fuel Consumption ' : ''}
              ${ghgData.dataTypesAvailable?.productionProcesses ? '✅ Production Processes ' : ''}
            </div>
            <div class="muted" style="margin-top: 6px;">
              Other: ${safe(ghgData.dataTypesAvailable?.otherDataTypes)}<br>
              Format: ${safe(ghgData.dataTypesAvailable?.dataFormat)}
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Additional Information & Requirements</div>
        <div class="row">
          <div class="col">
            <div class="label">Stakeholder Requirements</div>
            <div class="value" style="font-weight:500; line-height:1.4;">${safe(additional.stakeholderRequirements)}</div>
          </div>
          <div class="col">
            <div class="label">Additional Expectations</div>
            <div class="value" style="font-weight:500; line-height:1.4;">${safe(additional.additionalExpectations)}</div>
          </div>
        </div>
      </div>

      ${docs.length > 0 ? `
        <div class="card">
          <div class="badge">Supporting Documents (${docs.length})</div>
          <table>
            <thead>
              <tr>
                <th>Document Name</th>
                <th>Type</th>
                <th>Uploaded At</th>
              </tr>
            </thead>
            <tbody>
              ${docs.map(doc => `
                <tr>
                  <td><strong>${safe(doc.name)}</strong></td>
                  <td>${safe(doc.documentType)}</td>
                  <td class="muted">${doc.uploadedAt ? moment(doc.uploadedAt).format('DD MMM YYYY, HH:mm') : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}

      <div style="margin-top: 40px; padding: 20px; background: #f8fafc; border-radius: 8px; text-align: center; color: #6b7280; font-size: 12px;">
        <strong>ZeroCarbon Platform</strong> • Generated on ${moment().format('DD MMM YYYY, HH:mm [IST]')} • Confidential Document
      </div>
    </body></html>
  `;
}


/** PROPOSAL PDF */
function renderProposalHTML(client) {
  const p = client?.proposalData || {};
  const services = p?.servicesOffered || [];
  const additionalServices = p?.pricing?.additionalServices || [];
  const discounts = p?.pricing?.discounts || [];
  
  return `
    <!doctype html><html><head><meta charset="utf-8" />${baseCSS}</head>
    <body>
      ${renderHeader(
        client,
        'Service Proposal',
        `Generated on ${moment().format('DD MMM YYYY, HH:mm')} • Proposal #: ${p.proposalId || p.proposalNumber || '—'} • Valid Until: ${p.validUntil ? moment(p.validUntil).format('DD MMM YYYY') : '—'}`
      )}

      <div class="card">
        <div class="badge">Client Information</div>
        <div class="row">
          <div class="col">
            <div class="label">Company Name</div>
            <div class="value">${safe(p?.client?.companyName)}</div>
          </div>
          <div class="col">
            <div class="label">Contact Person</div>
            <div class="value">${safe(p?.client?.contactPerson?.name)}</div>
            <div class="muted">${safe(p?.client?.contactPerson?.designation)}</div>
          </div>
          <div class="col">
            <div class="label">Contact Details</div>
            <div class="value">📧 ${safe(p?.client?.contactPerson?.email)}</div>
            <div class="muted">📞 ${safe(p?.client?.contactPerson?.phone)}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Services Offered (${services.length} services)</div>
        ${services.map((service, index) => `
          <div style="margin: 16px 0; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; background: #f8fafc;">
            <div class="row">
              <div class="col" style="flex: 2;">
                <div class="label">Service ${index + 1}</div>
                <div class="value" style="font-size: 16px; margin-bottom: 8px;">${safe(service.serviceName)}</div>
                <div class="muted" style="line-height: 1.4; margin-bottom: 12px;">${safe(service.description)}</div>
              </div>
              <div class="col">
                <div class="label">Timeline</div>
                <div class="value">${safe(service.timeline)}</div>
              </div>
            </div>
            ${service.deliverables && service.deliverables.length > 0 ? `
              <div class="label" style="margin-top: 12px;">Deliverables</div>
              <ul style="margin: 8px 0; padding-left: 20px;">
                ${service.deliverables.map(deliverable => `<li style="margin: 4px 0; color: #4b5563;">${safe(deliverable)}</li>`).join('')}
              </ul>
            ` : ''}
          </div>
        `).join('')}
      </div>

      <div class="card">
        <div class="badge">Pricing Breakdown</div>
        <div class="row">
          <div class="col">
            <div class="label">Base Price</div>
            <div class="value" style="font-size: 18px; font-weight: 800; color: #1e40af;">${p?.pricing?.currency || 'INR'} ${(p?.pricing?.basePrice || 0).toLocaleString()}</div>
          </div>
          <div class="col">
            <div class="label">Currency</div>
            <div class="value">${p?.pricing?.currency || 'INR'}</div>
          </div>
          <div class="col">
            <div class="label">Payment Terms</div>
            <div class="value" style="font-weight:500; line-height: 1.3;">${safe(p?.pricing?.paymentTerms)}</div>
          </div>
        </div>

        ${additionalServices.length > 0 ? `
          <table style="margin-top: 16px;">
            <thead>
              <tr>
                <th>Additional Services</th>
                <th>Price (${p?.pricing?.currency || 'INR'})</th>
              </tr>
            </thead>
            <tbody>
              ${additionalServices.map(service => `
                <tr>
                  <td><strong>${safe(service.name)}</strong></td>
                  <td style="text-align: right; font-weight: 700;">${(service.price || 0).toLocaleString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        ${discounts.length > 0 ? `
          <table style="margin-top: 16px;">
            <thead>
              <tr>
                <th>Discounts Applied</th>
                <th>Amount (${p?.pricing?.currency || 'INR'})</th>
              </tr>
            </thead>
            <tbody>
              ${discounts.map(discount => `
                <tr>
                  <td><strong>${safe(discount.type)}</strong></td>
                  <td style="text-align: right; font-weight: 700; color: #059669;">-${(discount.amount || 0).toLocaleString()}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        <div style="margin-top: 20px; padding: 16px; background: linear-gradient(135deg, #fef3c7 0%, #fef9c3 100%); border: 2px solid #f59e0b; border-radius: 8px; text-align: center;">
          <div class="label">Total Project Amount</div>
          <div style="font-size: 28px; font-weight: 900; color: #92400e; margin: 8px 0;">
            ${p?.pricing?.currency || 'INR'} ${(p?.pricing?.totalAmount || 0).toLocaleString()}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Data Integration Summary</div>
        <div class="row">
          <div class="col">
            <div class="label">Total Data Integration Points</div>
            <div class="value" style="font-size: 24px; font-weight: 800; color: #3b82f6;">${p?.totalDataIntegrationPoints || 0}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Scope Details & Data Types</div>
        <table>
          <thead>
            <tr>
              <th>Scope Module</th>
              <th>Name</th>
              <th>Data Type</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(p?.scopes || {}).map(([scopeKey, scopeValue]) => `
              <tr>
                <td><strong>${scopeKey.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}</strong></td>
                <td>${safe(scopeValue?.name)}</td>
                <td class="muted">${safe(scopeValue?.dataType)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="badge">Consolidated Data Collection Plan</div>
        <table>
          <thead>
            <tr>
              <th>Scope</th>
              <th>Category</th>
              <th>Data Points</th>
              <th>Collection Methods</th>
            </tr>
          </thead>
          <tbody>
            ${Object.entries(p?.consolidatedData || {}).map(([scopeKey, scopeData]) => `
              <tr>
                <td><strong>${scopeKey.toUpperCase()}</strong></td>
                <td>${safe(scopeData?.category)}</td>
                <td style="text-align: center; font-weight: 700; color: #3b82f6;">${safe(scopeData?.totalDataPoints, 0)}</td>
                <td class="muted">
                  ${Array.isArray(scopeData?.collectionMethods) 
                    ? scopeData.collectionMethods.map(method => `<span class="badge" style="margin: 2px; font-size: 10px;">${method}</span>`).join(' ') 
                    : safe(scopeData?.collectionMethods)
                  }
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="card">
        <div class="badge">Service Level Agreement (SLA)</div>
        <div class="row">
          <div class="col">
            <div class="label">Response Time</div>
            <div class="value">${safe(p?.sla?.responseTime)}</div>
          </div>
          <div class="col">
            <div class="label">Resolution Time</div>
            <div class="value">${safe(p?.sla?.resolutionTime)}</div>
          </div>
          <div class="col">
            <div class="label">System Availability</div>
            <div class="value">${safe(p?.sla?.availability)}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="badge">Terms & Conditions</div>
        <div class="value" style="white-space: pre-wrap; line-height: 1.6; padding: 16px; background: #f8fafc; border-radius: 8px; margin-top: 12px;">
          ${safe(p.termsAndConditions, 'Standard terms and conditions apply. Please contact us for detailed terms.')}
        </div>
      </div>

      <div style="margin-top: 40px; padding: 20px; background: linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%); border-radius: 12px; text-align: center; border: 1px solid #3b82f6;">
        <div style="font-size: 18px; font-weight: 700; color: #1e40af; margin-bottom: 8px;">🌱 ZeroCarbon Platform</div>
        <div style="color: #6b7280; font-size: 14px; line-height: 1.5;">
          Empowering Sustainable Business Transformation<br>
          Generated on ${moment().format('DD MMM YYYY, HH:mm [IST]')} • Confidential Business Proposal
        </div>
      </div>
    </body></html>
  `;
}


module.exports = { renderClientDataHTML, renderProposalHTML };
