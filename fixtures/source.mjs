export const seed={
  "carrier": "C1",
  "leg": "L1",
  "billId": "B1",
  "kind": "master",
  "packages": 12
};
export const seedPath="/bill";
export const routes=[
  {
    "path": "/notices",
    "body": {
      "items": [
        {
          "noticeId": "n1",
          "leg": "L1",
          "revision": 1,
          "replaces": null,
          "bills": [
            {
              "billId": "B1",
              "kind": "master",
              "status": "active",
              "parent": null
            },
            {
              "billId": "H1",
              "kind": "house",
              "status": "active",
              "parent": "B1"
            }
          ],
          "moves": [
            {
              "cargoId": "c1",
              "from": null,
              "to": "H1"
            }
          ]
        }
      ]
    },
    "method": "GET",
    "status": 200,
    "query": {},
    "headers": {}
  },
  {
    "path": "/loads/c1",
    "body": {
      "leg": "L1",
      "cargoId": "c1",
      "container": "box1",
      "packages": 12,
      "version": 1
    },
    "method": "GET",
    "status": 200,
    "query": {},
    "headers": {}
  }
];
export const phases={
  "regroup": [
    {
      "path": "/notices",
      "body": {
        "items": [
          {
            "noticeId": "n2",
            "leg": "L1",
            "revision": 2,
            "replaces": "n1",
            "bills": [
              {
                "billId": "H1",
                "kind": "house",
                "status": "cancelled",
                "parent": "B1"
              },
              {
                "billId": "B2",
                "kind": "master",
                "status": "active",
                "parent": null
              }
            ],
            "moves": [
              {
                "cargoId": "c1",
                "from": "H1",
                "to": "B2"
              }
            ]
          }
        ]
      },
      "method": "GET",
      "status": 200,
      "query": {},
      "headers": {}
    }
  ],
  "missing-load": [
    {
      "path": "/loads/c1",
      "body": {
        "message": "箱单补发中"
      },
      "method": "GET",
      "status": 404,
      "query": {},
      "headers": {}
    }
  ],
  "reload": [
    {
      "path": "/loads/c1",
      "body": {
        "leg": "L1",
        "cargoId": "c1",
        "container": "box2",
        "packages": 10,
        "version": 2
      },
      "method": "GET",
      "status": 200,
      "query": {},
      "headers": {}
    }
  ]
};
export const portalKind="";
