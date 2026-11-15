import 'dotenv/config';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT ?? `http://localhost:${process.env.RUSTFS_PORT ?? 9000}`, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: process.env.RUSTFS_ACCESS_KEY, secretAccessKey: process.env.RUSTFS_SECRET_KEY } });
const key = process.argv[2];
console.log(await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.RUSTFS_BUCKET, Key: key }), { expiresIn: 7*24*3600 }));
