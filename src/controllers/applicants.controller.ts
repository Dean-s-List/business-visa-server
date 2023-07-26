import { logErrorToConsole } from "../utils/general.ts";
import type { Request, Response } from "express";
import { acceptApplicantBodyValidator } from "../validators/applicants.ts";
import {
    handleApiAuthError,
    handleApiClientError,
    handleApiRouteError,
    successHandler,
} from "../utils/api.ts";
import db from "../db/index.ts";
import { acceptedApplicantsTable } from "../db/schema/index.ts";
import env from "../env/index.ts";
import qstashClient from "../services/qstash.ts";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { addDays } from "date-fns";
import underdogApiInstance from "../services/underdog.ts";
import { UNDERDOG_BUSINESS_VISA_PROJECT_ID } from "../constants/UNDERDOG.ts";
import VISA_STATUS from "../constants/VISA_STATUS.ts";
import type { GetAllNftsResponse, NftMintResponse } from "../types/underdog.ts";
import resend from "../services/resend.ts";
import { DEANSLIST_EMAIL } from "../constants/EMAIL.ts";

export const acceptApplicant = async (req: Request, res: Response) => {
    try {
        const bodyValidationResult = acceptApplicantBodyValidator.safeParse(
            req.body
        );

        if (!bodyValidationResult.success) {
            logErrorToConsole(
                "/acceptApplicant error 400 =>",
                bodyValidationResult.error
            );
            return handleApiClientError(res);
        }

        const {
            secret,
            applicant: { walletAddress, name, email, discordId, country },
        } = bodyValidationResult.data;

        if (secret !== env.APP_SECRET) {
            logErrorToConsole(
                "/acceptApplicant error 401 =>",
                "Secret is not valid"
            );
            return handleApiAuthError(res);
        }

        const dbRes = await db.insert(acceptedApplicantsTable).values({
            walletAddress,
            name,
            email,
            discordId,
            country,
        });

        const { messageId } = await qstashClient.publishJSON({
            topic: "mint-visa",
            body: {
                secret: env.APP_SECRET,
                applicantId: dbRes.insertId,
            },
        });

        return res
            .status(200)
            .json(
                successHandler({ messageId }, "Applicant accepted successfully")
            );
    } catch (error) {
        logErrorToConsole("/acceptApplicant error 500 =>", error);
        return handleApiRouteError(res, error);
    }
};

export const mintApplicantVisa = async (req: Request, res: Response) => {
    try {
        const bodyValidationResult = z
            .object({
                secret: z.string(),
                applicantId: z
                    .string()
                    .transform((value) => parseInt(value, 10)),
            })
            .safeParse(req.body);

        if (!bodyValidationResult.success) {
            logErrorToConsole(
                "/mintApplicantVisa error 400 =>",
                bodyValidationResult.error
            );
            return handleApiClientError(res);
        }

        const { secret, applicantId } = bodyValidationResult.data;

        if (secret !== env.APP_SECRET) {
            logErrorToConsole(
                "/mintApplicantVisa error 401 =>",
                "Secret is not valid"
            );
            return handleApiAuthError(res);
        }

        const applicantData = await db
            .select()
            .from(acceptedApplicantsTable)
            .where(eq(acceptedApplicantsTable.id, applicantId));

        const applicant = applicantData[0];

        if (!applicantData || !applicant) {
            throw new Error("No usersData found!");
        }

        if (applicant.nftId) {
            throw new Error("User already has a nft!");
        }

        const issueDate = new Date();

        const expireDate = addDays(issueDate, 30);

        const limit = 1;

        const getAllNftsResponse = await underdogApiInstance.get(
            `/v2/projects/n/${UNDERDOG_BUSINESS_VISA_PROJECT_ID}/nfts?limit=${limit}`
        );

        const getAllNftsResponseData =
            getAllNftsResponse.data as GetAllNftsResponse;

        if (!getAllNftsResponseData) {
            throw new Error("Error fetching nfts from underdog api!");
        }

        const nftMintedCount = getAllNftsResponseData?.totalPages;

        if (!nftMintedCount) {
            throw new Error("Error fetching nfts minted count!");
        }

        const newNftIssueNumber = nftMintedCount + 1;

        const nftMetadata = {
            name: `The Dean's List Business Visa #${newNftIssueNumber}`,
            description:
                "Keep this active to gain access to USDC earning opportunities.",
            symbol: "DLBV",
            image: "https://dev.updg8.com/imgdata/9HdPsLjMBUW8fQTp314kg4LoiqGxQqvCxKk6uhHttjVp",
            attributes: {
                status: VISA_STATUS.ACTIVE,
                issuedAt: issueDate.getTime().toString(),
                expiresAt: expireDate.getTime().toString(),
            },
            receiverAddress: applicant.walletAddress,
        };

        const nftMintResponse = await underdogApiInstance.post(
            `/v2/projects/n/${UNDERDOG_BUSINESS_VISA_PROJECT_ID}/nfts`,
            nftMetadata
        );

        const nftMintResponseData = nftMintResponse.data as NftMintResponse;

        if (!nftMintResponseData) {
            throw new Error("Error minting nft!");
        }

        const underdogClaimLink = `https://claim.underdogprotocol.com/nfts/${
            nftMintResponseData.mintAddress
        }?network=${
            env.SOLANA_NETWORK === "mainnet-beta" ? "MAINNET_BETA" : "DEVNET"
        }`;

        await db.update(acceptedApplicantsTable).set({
            nftId: nftMintResponseData.id,
            nftIssuedAt: issueDate,
            nftExpiresAt: expireDate,
            hasClaimed: false,
            nftClaimLink: underdogClaimLink,
            nftMintAddress: nftMintResponseData.mintAddress,
        });

        await resend.sendEmail({
            to: applicant.email,
            from: DEANSLIST_EMAIL,
            subject: "Your Business Visa is ready!",
            text: `Your Business Visa is ready! Claim it here: ${underdogClaimLink}`,
        });

        return res.status(200).json(
            successHandler(
                {
                    nftClaimLink: underdogClaimLink,
                    nftMintAddress: nftMintResponseData.mintAddress,
                },
                "Business visa claim link sent to applicant successfully"
            )
        );
    } catch (error) {
        logErrorToConsole("/mintApplicantVisa error 500 =>", error);
        return handleApiRouteError(res, error);
    }
};
