import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as synced_folder from "@pulumi/synced-folder";

// TODO: run the build first
const build_dir = "../GameSiteFE/build";
const fe_name = "gamesite-fe";
const domain_name = "geofroy.ca";

// Create a GCP resource (Storage Bucket)
const fe_bucket = new gcp.storage.Bucket(fe_name, {
  location: "US",
  storageClass: "COLDLINE",
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
const backendBucket = new gcp.compute.BackendBucket("backend-bucket", {
  bucketName: fe_bucket.name,
  enableCdn: true,
});

// Provision a global IP address for the CDN.
const ip = new gcp.compute.GlobalAddress("ip", {});

// Create a URLMap to route requests to the storage bucket.
const urlMap = new gcp.compute.URLMap("url-map", {
  defaultService: backendBucket.selfLink,
});

const sslCert = new gcp.compute.ManagedSslCertificate(`${fe_name}-cert`, {
  managed: {
    domains: [domain_name],
  },
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
