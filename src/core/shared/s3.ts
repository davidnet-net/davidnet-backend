import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

export const s3 = new S3Client({
	region: "garage",
	endpoint: "http://garage.garage.svc.cluster.local:3900",
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
