{
  "clientId": "Greon100",
  "flowchartData": {
    "nodes": [
      {
        "id": "ClassicNod1Manualboth",
        "label": "Main Facility",
        "position": { "x": 100, "y": 100 },
        "parentNode": null,
        "details": {
          "nodeType": "facility",
          "department": "Production",
          "location": "Mumbai",
                    "employeeHeadId":"68883c52012c51472985e112",

         
          "additionalDetails": {}
        }
      },
      {
        "id": "ClassicNod2Manualboth",
        "label": "Warehouse Hub",
        "position": { "x": 400, "y": 150 },
        "parentNode": null,
        "details": {
          "nodeType": "warehouse",
          "department": "Logistics",
          "location": "Pune",
        
          "additionalDetails": {}
        }
      },
      {
        "id": "ClassicNod3Manualboth",
        "label": "Head Office",
        "position": { "x": 700, "y": 300 },
        "parentNode": null,
        "details": {
          "nodeType": "office",
          "department": "Corporate",
          "location": "Bangalore",
          
          "additionalDetails": {}
        }
      },
      {
        "id": "FuelEnergyNod1Manualboth",
        "label": "Fuel & Energy",
        "position": { "x": 250, "y": 250 },
        "parentNode": "ClassicNod1",
        "details": {
          "nodeType": "process",
          "department": "Utilities",
          "location": "Mumbai",
          
          "additionalDetails": {}
        }
      }
    ],
    "edges": [
      {
        "id": "Classicedg1Manualboth",
        "source": "ClassicNod1Manualboth",
        "target": "ClassicNod2Manualboth",
        "sourcePosition": "right",
        "targetPosition": "left"
      },
      {
        "id": "Classicedg2Manualboth",
        "source": "ClassicNod1Manualboth",
        "target": "ClassicNod2Manualboth",
        "sourcePosition": "bottom",
        "targetPosition": "top"
      },
      {
        "id": "Classicedg3Manualboth",
        "source": "ClassicNod2Manualboth",
        "target": "ClassicNod3Manualboth",
        "sourcePosition": "right",
        "targetPosition": "left"
      },
      {
        "id": "Classicedg4Manualboth",
        "source": "FuelEnergyNod1Manualboth",
        "target": "ClassicNod1Manualboth",
        "sourcePosition": "left",
        "targetPosition": "top"
      },
      {
        "id": "Classicedg5Manualboth",
        "source": "ClassicNod1Manualboth",
        "target": "ClassicNod3Manualboth",
        "sourcePosition": "right",
        "targetPosition": "left"
      },
      {
        "id": "Classicedg6Manualboth",
        "source": "ClassicNod2Manualboth",
        "target": "FuelEnergyNod1Manualboth",
        "sourcePosition": "bottom",
        "targetPosition": "top"
      },
      {
        "id": "Classicedg7Manualboth",
        "source": "ClassicNod3Manualboth",
        "target": "FuelEnergyNod1Manualboth",
        "sourcePosition": "bottom",
        "targetPosition": "right"
      },
      {
        "id": "Classicedg8Manualboth",
        "source": "ClassicNod3Manualboth",
        "target": "FuelEnergyNod1Manualboth",
        "sourcePosition": "top",
        "targetPosition": "bottom"
      }
    ]
  }
}