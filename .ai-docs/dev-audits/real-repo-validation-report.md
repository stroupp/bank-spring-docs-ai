# Real Repo Validation Report

Generated at: 2026-07-11T18:49:47.820Z
Mode: offline/cached-only

## Run Summary

- Repositories configured: 3
- Analyzer runs completed: 7
- Warnings: 0
- AI calls: 0

The runner does not import or invoke Qwen, Copilot, or other AI clients. Its only network operations are Git clone/fetch commands; repository source remained local and was processed only by deterministic analyzers.

## inventory-management-API

- URL: https://github.com/Sebaspallero/inventory-management-API.git
- Configured branch: main
- Analyzed branch: main
- Type: spring-be
- Clone status: cached
- Description: Real-life inventory management Spring Boot backend

### Analyzer Results

```json
[
  {
    "role": "be",
    "root": ".tmp\\real-repo-validation\\inventory-management-api",
    "files": 107,
    "endpoints": 71,
    "components": 97,
    "entities": 8,
    "methodCalls": 782
  }
]
```

### Warnings

- None

## rbac-ums

- URL: https://github.com/mpiumakkho/rbac-ums.git
- Configured branch: main
- Analyzed branch: master
- Type: ui-bff-be-monorepo
- Clone status: cached
- Description: React UI + Spring BFF + Spring backend structure

### Analyzer Results

```json
[
  {
    "role": "ui",
    "root": ".tmp\\real-repo-validation\\rbac-ums\\frontend",
    "files": 12,
    "routes": 5,
    "components": 7,
    "apiCalls": 3
  },
  {
    "role": "bff",
    "root": ".tmp\\real-repo-validation\\rbac-ums\\web-api",
    "files": 17,
    "endpoints": 6,
    "components": 15,
    "entities": 0,
    "outboundCalls": 6
  },
  {
    "role": "be",
    "root": ".tmp\\real-repo-validation\\rbac-ums\\core-api",
    "files": 127,
    "endpoints": 61,
    "components": 92,
    "entities": 12,
    "methodCalls": 1281
  }
]
```

### Warnings

- None

## bff-spring-keycloak-react-demo

- URL: https://github.com/HQT-Team/bff-spring-keycloak-react-demo.git
- Configured branch: main
- Analyzed branch: main
- Type: ui-bff-be-monorepo
- Clone status: cached
- Description: Java Spring BFF + React + backend demo

### Analyzer Results

```json
[
  {
    "role": "ui",
    "root": ".tmp\\real-repo-validation\\bff-spring-keycloak-react-demo\\backoffice",
    "files": 26,
    "routes": 0,
    "components": 8,
    "apiCalls": 1
  },
  {
    "role": "bff",
    "root": ".tmp\\real-repo-validation\\bff-spring-keycloak-react-demo\\backoffice-bff",
    "files": 7,
    "endpoints": 1,
    "components": 4,
    "entities": 0,
    "outboundCalls": 0
  },
  {
    "role": "be",
    "root": ".tmp\\real-repo-validation\\bff-spring-keycloak-react-demo\\product",
    "files": 8,
    "endpoints": 2,
    "components": 6,
    "entities": 0,
    "methodCalls": 17
  }
]
```

### Warnings

- None

## Interpretation

This runner is diagnostic. Clone/network failures are warnings and do not fail compile or automated tests. Fixture tests remain the reproducible regression gate.
