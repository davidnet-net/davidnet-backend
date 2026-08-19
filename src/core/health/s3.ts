import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";

if (!process.env.GARAGE_ACCESS_KEY || !process.env.GARAGE_SECRET_KEY) {
	console.error("CRITICAL: Garage credentials are missing from environment variables!");
}

const s3 = new S3Client({
	region: "garage",
	endpoint: "http://garage.garage.svc.cluster.local:3900",
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.GARAGE_ACCESS_KEY!,
		secretAccessKey: process.env.GARAGE_SECRET_KEY!
	}
});

export async function checkS3Health(): Promise<boolean> {
	try {
		await s3.send(new HeadBucketCommand({ Bucket: "profile-pictures" }));
		return true;
	} catch (error) {
		if (process.env.NODE_ENV !== "production") {
			console.log("Silenced Garage health-check failed.", process.env.NODE_ENV);
		} else {
			console.error("Storage health-check failed:", error);
		}

		return false;
	}
}
