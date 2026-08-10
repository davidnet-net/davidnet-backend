import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
	region: "garage",
	endpoint: process.env.GARAGE_ENDPOINT,
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
		console.error("Storage health-check failed:", error);
		return false;
	}
}
