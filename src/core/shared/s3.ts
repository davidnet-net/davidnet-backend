import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command
} from "@aws-sdk/client-s3";

export const s3 = new S3Client({
	region: "garage",
	// Defaults to the in-cluster Garage service used in prod; override with GARAGE_ENDPOINT
	// (e.g. http://localhost:3900) to point at the local docker-compose Garage instead.
	endpoint: process.env.GARAGE_ENDPOINT || "http://garage.garage.svc.cluster.local:3900",
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.GARAGE_ACCESS_KEY!,
		secretAccessKey: process.env.GARAGE_SECRET_KEY!
	}
});

export async function uploadToBucket(
	bucket: string,
	key: string,
	body: Buffer,
	contentType: string
) {
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: contentType
		})
	);
}

export async function getFromBucket(bucket: string, key: string) {
	const response = await s3.send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: key
		})
	);
	return response;
}

export async function listBucketObjects(bucket: string, prefix: string): Promise<string[]> {
	const response = await s3.send(
		new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: prefix
		})
	);
	return (response.Contents || [])
		.map((item) => item.Key)
		.filter((key): key is string => Boolean(key));
}
