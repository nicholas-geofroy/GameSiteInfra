import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as synced_folder from "@pulumi/synced-folder";

// TODO: run the build first
const build_dir = "../GameSiteFE/build";
const fe_name = "gamesite-fe";
const domain_name = "geofroy.ca";

// FRONTEND
// Create a GCP resource (Storage Bucket)
const fe_bucket = new gcp.storage.Bucket(fe_name, {
  location: "US",
  storageClass: "STANDARD",
  forceDestroy: true,
  website: {
    mainPageSuffix: `index.html`,
    notFoundPage: `index.html`,
  },
});

// Create an IAM binding to allow public read access to the bucket.
const bucketIamBinding = new gcp.storage.BucketIAMBinding(
  `${fe_name}-iam-binding`,
  {
    bucket: fe_bucket.name,
    role: "roles/storage.objectViewer",
    members: ["allUsers"],
  }
);

// Use a synced folder to manage the files of the website.
const syncedFolder = new synced_folder.GoogleCloudFolder("synced-folder", {
  path: build_dir,
  bucketName: fe_bucket.name,
});

// Enable the storage bucket as a CDN.
const frontendBucket = new gcp.compute.BackendBucket("backend-bucket", {
  bucketName: fe_bucket.name,
  enableCdn: true,
});

// Provision a global IP address for the CDN.
const ip = new gcp.compute.GlobalAddress("ip", {});

const sslCert = new gcp.compute.ManagedSslCertificate(`${fe_name}-cert`, {
  managed: {
    domains: [domain_name, `api.${domain_name}`],
  },
});

// BACKEND
const backend_sa = new gcp.serviceaccount.Account("backend-sa", {
  accountId: "gamesite-be-sa",
  displayName: "Gamesite BE Service Account",
});

const registry = new gcp.container.Registry("backend", {});

const backend_read_image = new gcp.storage.BucketIAMMember("be-read-image", {
  bucket: registry.id,
  member: pulumi.interpolate`serviceAccount:${backend_sa.email}`,
  role: "roles/storage.objectViewer",
});

const container_declaration = `
spec:
  containers:
  - name: instance-1
    image: gcr.io/gamesite-369621/backend:latest
`;

const compute_instance = new gcp.compute.Instance("gamesite-be-instance", {
  machineType: "e2-micro",
  zone: "us-west1-a",
  bootDisk: {
    initializeParams: {
      image: "projects/cos-cloud/global/images/family/cos-stable",
    },
  },
  metadata: {
    "gce-container-declaration": container_declaration,
  },
  networkInterfaces: [
    {
      network: "default",
      accessConfigs: [{}],
    },
  ],
  serviceAccount: {
    email: backend_sa.email,
    scopes: ["cloud-platform"],
  },
  tags: ["allow-health-check"],
});

const be_ig = new gcp.compute.InstanceGroup("backend-instance-group", {
  description: "Backend instance group",
  zone: "us-west1-a",
  network: compute_instance.networkInterfaces[0].network,
  instances: [compute_instance.selfLink],
  namedPorts: [
    {
      name: "http",
      port: 9000,
    },
  ],
});

const allow_health_check = new gcp.compute.Firewall("fw-allow-health-check", {
  direction: "INGRESS",
  network: "default",
  sourceRanges: ["130.211.0.0/22", "35.191.0.0/16"],
  targetTags: ["allow-health-check"],
  allows: [
    {
      ports: ["9000"],
      protocol: "tcp",
    },
  ],
});

const backend_health_check = new gcp.compute.HealthCheck(
  "backend-health-check",
  {
    checkIntervalSec: 5,
    httpHealthCheck: {
      port: 9000,
    },
    timeoutSec: 1,
  }
);

const backend_service = new gcp.compute.BackendService("backend-service", {
  backends: [
    {
      group: be_ig.selfLink,
    },
  ],
  portName: "http",
  healthChecks: backend_health_check.selfLink,
});

// ROUTING
// Create a URLMap to route requests to the storage bucket.
const urlMap = new gcp.compute.URLMap("url-map", {
  defaultService: frontendBucket.selfLink,
  hostRules: [
    {
      hosts: ["geofroy.ca"],
      pathMatcher: "frontend",
    },
    {
      hosts: ["api.geofroy.ca"],
      pathMatcher: "backend",
    },
  ],
  pathMatchers: [
    {
      name: "frontend",
      defaultService: frontendBucket.selfLink,
    },
    {
      name: "backend",
      defaultService: backend_service.selfLink,
    },
  ],
});

// Create an HTTPS proxy to route requests to the URLMap.
const httpsProxy = new gcp.compute.TargetHttpsProxy("https-proxy", {
  urlMap: urlMap.selfLink,
  sslCertificates: [sslCert.name],
});

// Create a GlobalForwardingRule rule to route requests to the HTTP proxy.
const httpsForwardingRule = new gcp.compute.GlobalForwardingRule(
  `${fe_name}-https-forwarding-rule`,
  {
    ipAddress: ip.address,
    ipProtocol: "TCP",
    portRange: "443",
    target: httpsProxy.selfLink,
  }
);

//Redirect HTTP to HTTPs
const httpUrlMap = new gcp.compute.URLMap("http-redirect-url-map", {
  defaultUrlRedirect: {
    hostRedirect: ip.address,
    httpsRedirect: true,
    stripQuery: false,
  },
});
const httpProxy = new gcp.compute.TargetHttpProxy("http-proxy", {
  urlMap: httpUrlMap.selfLink,
});
const httpForwardingRule = new gcp.compute.GlobalForwardingRule(
  `${fe_name}-http-redirect-forwarding-rule`,
  {
    ipAddress: ip.address,
    ipProtocol: "TCP",
    portRange: "80",
    target: httpProxy.selfLink,
  }
);

// Export the URLs and hostnames of the bucket and CDN.
export const originURL = pulumi.interpolate`https://storage.googleapis.com/${fe_bucket.name}/index.html`;
export const originHostname = pulumi.interpolate`storage.googleapis.com/${fe_bucket.name}`;
export const cdnURL = pulumi.interpolate`http://${ip.address}`;
export const cdnHostname = ip.address;
