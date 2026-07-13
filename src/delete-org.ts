mport { AppDataSource } from "./config/database.js";

async function deleteOrg() {
    const orgId = 3;
    await AppDataSource.initialize();
    const queryRunner = AppDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
        console.log(`Starting permanent deletion of Organization ID: ${orgId}...`);

        // 1. Reset user latest context references to this Organization or its Hospitals
        await queryRunner.query(`
            UPDATE [Users] 
            SET [LatestOrgId] = NULL 
            WHERE [LatestOrgId] = @0
        `, [orgId]);

        await queryRunner.query(`
            UPDATE [Users] 
            SET [LatestHospitalId] = NULL 
            WHERE [LatestHospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
        `, [orgId]);

        // 2. Delete grandchild records referencing Appointments
        // (e.g. PatientVerifications, AppointmentBillItems, AppointmentBills)
        await queryRunner.query(`
            DELETE FROM [PatientVerifications]
            WHERE [AppointmentId] IN (SELECT [Id] FROM [Appointments] WHERE [OrgId] = @0)
        `, [orgId]);

        await queryRunner.query(`
            DELETE FROM [AppointmentBillItems]
            WHERE [AppointmentBillId] IN (
                SELECT [AppointmentBillId] FROM [AppointmentBills] 
                WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
            )
        `, [orgId]);

        await queryRunner.query(`
            DELETE FROM [AppointmentBills]
            WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
        `, [orgId]);

        // 3. Delete clinical and medical records referencing Org or Hospitals
        await queryRunner.query(`DELETE FROM [PatientClinicalNotes] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [PatientPrescription] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [PatientMedicalRecord] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [MedicalDocuments] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [PostVisitDocuments] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [MeetingRedirections] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [AppointmentShareLinks] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [TreatmentPlans] WHERE [OrgId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [APILogs] WHERE [OrgId] = @0`, [orgId]);

        // 4. Delete Appointments
        await queryRunner.query(`DELETE FROM [Appointments] WHERE [OrgId] = @0`, [orgId]);

        // 5. Delete Healthcare Provider schedules and slots
        await queryRunner.query(`DELETE FROM [HealthcareProviderScheduleSlots] WHERE [OrganizationId] = @0`, [orgId]);

        await queryRunner.query(`
            DELETE FROM [HealthcareProviderAvailability]
            WHERE [ProviderId] IN (
                SELECT [Id] FROM [HealthcareProviders] 
                WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
            )
        `, [orgId]);

        // 6. Delete Healthcare Providers
        await queryRunner.query(`
            DELETE FROM [HealthcareProviders]
            WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
        `, [orgId]);

        // 7. Delete Hospital departments, specialties, and payment configurations
        await queryRunner.query(`
            DELETE FROM [HospitalDepartments]
            WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
        `, [orgId]);

        await queryRunner.query(`
            DELETE FROM [HospitalSpecialties]
            WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
        `, [orgId]);

        await queryRunner.query(`
            DELETE FROM [HospitalSubSpecialties]
            WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
        `, [orgId]);

        await queryRunner.query(`
            DELETE FROM [HospitalPaymentConfigurations]
            WHERE [HospitalId] IN (SELECT [Id] FROM [Hospitals] WHERE [OrganizationId] = @0)
        `, [orgId]);

        // 8. Delete organization registration links, consent templates, consent requests, and menus
        await queryRunner.query(`DELETE FROM [UserRegistrationLinks] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [ConsentTemplates] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [ConsentRequests] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [RoleSidebarMenus] WHERE [OrganizationId] = @0`, [orgId]);

        // 9. Delete patient registrations and insurance profiles
        await queryRunner.query(`DELETE FROM [PatientRegistrations] WHERE [OrganizationId] = @0`, [orgId]);
        await queryRunner.query(`DELETE FROM [PatientInsurances] WHERE [OrganizationId] = @0`, [orgId]);

        // 10. Delete UserRoles assigned under this Organization
        await queryRunner.query(`DELETE FROM [UserRoles] WHERE [OrganizationId] = @0`, [orgId]);

        // 11. Delete Hospitals under the Organization
        await queryRunner.query(`DELETE FROM [Hospitals] WHERE [OrganizationId] = @0`, [orgId]);

        // 12. Delete the Organization record itself
        await queryRunner.query(`DELETE FROM [Organizations] WHERE [Id] = @0`, [orgId]);

        await queryRunner.commitTransaction();
        console.log(`SUCCESS: Organization ID ${orgId} and all associated records permanently removed.`);
    } catch (err) {
        console.error("ERROR running delete transaction, rolling back...", err);
        await queryRunner.rollbackTransaction();
    } finally {
        await queryRunner.release();
        await AppDataSource.destroy();
    }
}

deleteOrg();
